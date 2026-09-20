/**
 * The online server's half of desktop pairing: issuing codes from the
 * super-admin console, and trading a redeemed code for a snapshot of the
 * business configuration.
 *
 * DB-touching, so per repo convention it has no direct unit test — the pure
 * logic it leans on is covered by pairing-codes.test.ts and
 * pairing-snapshot.test.ts, and the transactional behaviour by
 * integration/pairing.integration.test.ts.
 */
import { createHash } from "node:crypto";
import { getPool, query, withoutTenantScope } from "./db";
import { effectiveFeatures } from "./features";
import type { Industry } from "./industries";
import {
  generatePairingCode,
  hashPairingCode,
  pairingCodeState,
  PAIRING_CODE_TTL_HOURS,
  type PairingCodeState,
} from "./pairing-codes";
import { PAIRING_SNAPSHOT_VERSION, type PairingSnapshot } from "./pairing-snapshot";
import { SETTING_KEYS } from "./settings";
import { generateSyncToken } from "./sync-token";

export interface PairingCodeSummary {
  id: string;
  businessId: string;
  locationId: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: PairingCodeState;
}

// A type alias rather than an interface: `query<T>` constrains T to
// Record<string, unknown>, which only object-literal aliases satisfy (see the
// row types in api-auth.ts and server-sync.ts for the same shape).
type CodeRow = {
  id: string;
  business_id: string;
  location_id: string;
  expires_at: Date;
  redeemed_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

function toSummary(row: CodeRow, now: Date): PairingCodeSummary {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    expiresAt: row.expires_at.toISOString(),
    redeemedAt: row.redeemed_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    state: pairingCodeState(
      { expiresAt: row.expires_at, redeemedAt: row.redeemed_at, revokedAt: row.revoked_at },
      now,
    ),
  };
}

/**
 * Issue a fresh code for a business, revoking whatever live code it already
 * had. The partial unique index enforces one-live-per-business, so revoking
 * first is not a nicety — it is what makes re-issuing possible at all.
 *
 * Runs under whichever scope the caller already established: the console wraps
 * it in `withPlatformScope`, and the owner's own «اتصال دستگاه» panel wraps it
 * in the ordinary tenant scope (`withTenantScope`), where RLS's `WITH CHECK`
 * confines the insert to the caller's business without needing a bypass.
 *
 * `issuedBy` is a `platform_users.id` and is nullable in the schema, so an
 * owner issuing their own code passes `session.platformUserId` — which is null
 * for a PIN-only staff login, and null is the honest value there rather than a
 * borrowed identity. (Only Owners reach this, and Owners are password logins,
 * so in practice it is set.)
 */
export async function listPairingLocations(businessId: string): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations WHERE business_id = $1 AND is_active ORDER BY name, created_at`,
    [businessId],
  );
  return rows;
}

export async function issuePairingCode(
  businessId: string,
  issuedBy: string | null,
  locationId: string,
): Promise<{ code: string; summary: PairingCodeSummary } | { error: "no_location" | "invalid_location" }> {
  if (!locationId) return { error: "no_location" };
  const { rows: locationRows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE id = $1 AND business_id = $2 AND is_active`,
    [locationId, businessId],
  );
  if (!locationRows[0]) return { error: "invalid_location" };

  const code = generatePairingCode();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE install_pairing_codes SET revoked_at = now()
        WHERE business_id = $1 AND location_id = $2
          AND redeemed_at IS NULL AND revoked_at IS NULL`,
      [businessId, locationId],
    );
    const { rows } = await client.query<CodeRow>(
      `INSERT INTO install_pairing_codes
         (business_id, location_id, code_hash, expires_at, issued_by)
       VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval, $5)
       RETURNING id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at`,
      [businessId, locationId, hashPairingCode(code), String(PAIRING_CODE_TTL_HOURS), issuedBy],
    );
    await client.query("COMMIT");
    return { code, summary: toSummary(rows[0], new Date()) };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listPairingCodes(businessId: string): Promise<PairingCodeSummary[]> {
  const { rows } = await query<CodeRow>(
    `SELECT id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at
       FROM install_pairing_codes
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT 20`,
    [businessId],
  );
  const now = new Date();
  return rows.map((row) => toSummary(row, now));
}

/** Revoke a still-live code. Returns false if there was nothing live to revoke. */
export async function revokePairingCode(businessId: string, codeId: string): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE install_pairing_codes SET revoked_at = now()
      WHERE id = $1 AND business_id = $2 AND redeemed_at IS NULL AND revoked_at IS NULL`,
    [codeId, businessId],
  );
  return (rowCount ?? 0) > 0;
}

export type RedeemResult =
  | { ok: true; snapshot: PairingSnapshot }
  | {
      ok: false;
      error: "code_not_found" | "code_expired" | "code_already_redeemed" | "code_revoked";
    };

/**
 * Trade a pairing code for a snapshot of its business.
 *
 * Bypassed (`pairing-redeem`): the code is a bearer-style credential and
 * resolving it to a business is exactly the "identify the tenant first"
 * problem login and server-sync-auth already have. The bypass covers the
 * lookup, the mark-as-redeemed, and the reads that build the snapshot — all
 * for the one business the code names.
 *
 * The code is marked redeemed in the same transaction as the lookup, under a
 * row lock, so two desktops racing the same code can never both get a
 * snapshot.
 */
export async function redeemPairingCode(
  rawCode: string,
  clientIp: string | null,
  deviceName = "Windows Business Suite",
): Promise<RedeemResult> {
  return withoutTenantScope("pairing-redeem", async () => {
    const client = await getPool().connect();
    let businessId: string;
    let locationId: string;
    let siteDevice!: PairingSnapshot["siteDevice"];
    let syncToken!: string;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<CodeRow>(
        `SELECT id, business_id, location_id, expires_at, redeemed_at, revoked_at, created_at
           FROM install_pairing_codes WHERE code_hash = $1 FOR UPDATE`,
        [hashPairingCode(rawCode)],
      );
      const row = rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return { ok: false, error: "code_not_found" };
      }

      const state = pairingCodeState(
        { expiresAt: row.expires_at, redeemedAt: row.redeemed_at, revokedAt: row.revoked_at },
        new Date(),
      );
      if (state !== "valid") {
        await client.query("ROLLBACK");
        return { ok: false, error: state };
      }

      businessId = row.business_id;
      locationId = row.location_id;
      syncToken = generateSyncToken();
      const cleanDeviceName = deviceName.trim().slice(0, 120) || "Windows Business Suite";
      const deviceRows = await client.query<{ id: string; public_id: string; display_name: string }>(
        `INSERT INTO site_devices (business_id, location_id, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, public_id, display_name`,
        [businessId, locationId, cleanDeviceName],
      );
      const device = deviceRows.rows[0];
      await client.query(
        `INSERT INTO site_sync_credentials (site_device_id, business_id, token_hash)
         VALUES ($1, $2, $3)`,
        [device.id, businessId, createHash("sha256").update(syncToken).digest("hex")],
      );
      await client.query(
        `UPDATE install_pairing_codes SET redeemed_at = now(), redeemed_ip = $2 WHERE id = $1`,
        [row.id, clientIp],
      );
      await client.query("COMMIT");
      siteDevice = { id: device.id, publicId: device.public_id, displayName: device.display_name };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return {
      ok: true,
      snapshot: await buildPairingSnapshot(businessId, locationId, siteDevice, syncToken),
    };
  });
}

/**
 * Read the business's configuration into a transportable snapshot.
 *
 * Deliberately excludes everything transactional (orders, ledger entries,
 * stock movements) and everything machine-specific (backup destinations,
 * rollup config, sync state). What is left is the configuration a till needs
 * to start selling.
 *
 * Must be called from inside a bypassed scope — `redeemPairingCode` provides
 * one; it is exported only so the integration test can exercise it directly.
 */
export async function buildPairingSnapshot(
  businessId: string,
  locationId: string,
  siteDevice: PairingSnapshot["siteDevice"],
  syncToken: string,
): Promise<PairingSnapshot> {
  const [
    bizRes,
    locRes,
    userRes,
    assignRes,
    accountRes,
    catRes,
    itemRes,
    mediaAssetRes,
    modifierGroupRes,
    modifierRes,
    itemModifierRes,
    diningRes,
    inventoryRes,
    menuIngredientRes,
    modifierIngredientRes,
    paymentMethodRes,
    settingRes,
    features,
  ] = await Promise.all([
      query<{ id: string; name: string; slug: string; timezone: string; industry: Industry }>(
        `SELECT id, name, slug::text AS slug, subdomain::text AS subdomain, timezone, industry
           FROM businesses WHERE id = $1`,
        [businessId],
      ),
      query<{
        id: string;
        name: string;
        address: string | null;
        phone: string | null;
        timezone: string;
      }>(`SELECT id, name, address, phone, timezone FROM locations WHERE id = $1`, [locationId]),
      query<{
        id: string;
        role: string;
        full_name: string;
        email: string | null;
        permissions: Record<string, unknown>;
        pin_hash: string | null;
        password_hash: string | null;
        pu_email: string | null;
        pu_full_name: string | null;
        pu_password_hash: string | null;
      }>(
        `SELECT u.id, u.role::text AS role, u.full_name, u.email::text AS email, u.permissions,
                u.pin_hash, u.password_hash,
                pu.email::text AS pu_email, pu.full_name AS pu_full_name,
                pu.password_hash AS pu_password_hash
           FROM users u
           LEFT JOIN platform_users pu ON pu.id = u.platform_user_id
          WHERE u.business_id = $1 AND u.is_active`,
        [businessId],
      ),
      query<{ user_id: string; location_id: string }>(
        `SELECT ul.user_id, ul.location_id
           FROM user_locations ul
           JOIN users u ON u.id = ul.user_id
          WHERE u.business_id = $1`,
        [businessId],
      ),
      query<{ id: string; parent_code: string | null; code: string; name: string; type: string }>(
        `SELECT a.id, p.code AS parent_code, a.code, a.name, a.type::text AS type
           FROM accounts a
           LEFT JOIN accounts p ON p.id = a.parent_id
          WHERE a.business_id = $1 AND a.is_active
          ORDER BY a.code`,
        [businessId],
      ),
      query<{ id: string; name: string; sort_order: number; is_active: boolean }>(
        `SELECT id, name, sort_order, is_active FROM menu_categories
          WHERE location_id = $1 ORDER BY sort_order, name`,
        [locationId],
      ),
      query<{
        id: string;
        category_id: string | null;
        name: string;
        description: string | null;
        sku: string | null;
        price: string;
        image_url: string | null;
        image_media_id: string | null;
        is_active: boolean;
        sort_order: number;
      }>(
        `SELECT id, category_id, name, description, sku, price, image_url, image_media_id,
                is_active, sort_order
           FROM menu_items WHERE location_id = $1 ORDER BY sort_order, name`,
        [locationId],
      ),
      // v4: the media rows this branch's menu actually points at. Minimal
      // replication — metadata only; the bytes are fetched from this server
      // on demand, so pairing never stalls on image payloads.
      query<{
        id: string;
        kind: string;
        file_name: string;
        mime_type: string;
        byte_size: string;
        storage_key: string;
        sha256: string;
      }>(
        `SELECT DISTINCT ma.id, ma.kind, ma.file_name, ma.mime_type,
                ma.byte_size::text AS byte_size, ma.storage_key, ma.sha256
           FROM media_assets ma
           JOIN menu_items mi ON mi.image_media_id = ma.id
          WHERE mi.location_id = $1`,
        [locationId],
      ),
      query<{
        id: string;
        name: string;
        min_select: number;
        max_select: number;
        is_active: boolean;
        sort_order: number;
      }>(
        `SELECT id, name, min_select, max_select, is_active, sort_order
           FROM modifier_groups WHERE location_id = $1 ORDER BY sort_order, name, id`,
        [locationId],
      ),
      query<{
        id: string;
        group_id: string;
        name: string;
        price_delta: string;
        is_active: boolean;
        sort_order: number;
      }>(
        `SELECT id, group_id, name, price_delta, is_active, sort_order
           FROM modifiers WHERE location_id = $1 ORDER BY group_id, sort_order, name`,
        [locationId],
      ),
      query<{
        menu_item_id: string;
        modifier_group_id: string;
        min_select_override: number | null;
        max_select_override: number | null;
        sort_order: number;
        is_active: boolean;
      }>(
        `SELECT mm.menu_item_id, mm.modifier_group_id, mm.min_select_override,
                mm.max_select_override, mm.sort_order, mm.is_active
           FROM menu_item_modifier_groups mm
           JOIN menu_items mi ON mi.id = mm.menu_item_id
          WHERE mi.location_id = $1`,
        [locationId],
      ),
      query<{
        id: string;
        name: string;
        zone: string | null;
        capacity: number;
        sort_order: number;
        is_active: boolean;
      }>(
        `SELECT id, name, zone, capacity, sort_order, is_active
           FROM dining_tables WHERE location_id = $1 ORDER BY sort_order, name`,
        [locationId],
      ),
      query<{
        id: string;
        name: string;
        sku: string | null;
        unit: string;
        reorder_level: string | null;
        avg_cost: string;
        purchase_unit: string | null;
        purchase_unit_factor: string;
        carrying_value_rial: string | null;
        is_produced: boolean;
        is_active: boolean;
      }>(
        `SELECT id, name, sku, unit, reorder_level, avg_cost, purchase_unit,
                purchase_unit_factor, carrying_value_rial, is_produced, is_active
           FROM inventory_items WHERE location_id = $1 ORDER BY name, id`,
        [locationId],
      ),
      query<{ menu_item_id: string; inventory_item_id: string; quantity: string }>(
        `SELECT m.menu_item_id, m.inventory_item_id, m.quantity
           FROM menu_item_ingredients m
           JOIN menu_items mi ON mi.id = m.menu_item_id
          WHERE mi.location_id = $1`,
        [locationId],
      ),
      query<{ modifier_id: string; inventory_item_id: string; quantity_delta: string }>(
        `SELECT m.modifier_id, m.inventory_item_id, m.quantity_delta
           FROM modifier_ingredients m
           JOIN modifiers md ON md.id = m.modifier_id
          WHERE md.location_id = $1`,
        [locationId],
      ),
      query<{
        id: string;
        code: string;
        name: string;
        settlement: string;
        sort_order: number;
        is_active: boolean;
        is_builtin: boolean;
        opens_drawer: boolean;
        requires_reference: boolean;
      }>(
        `SELECT id, code, name, settlement::text AS settlement, sort_order,
                is_active, is_builtin, opens_drawer, requires_reference
           FROM payment_methods WHERE business_id = $1 ORDER BY sort_order, name`,
        [businessId],
      ),
      query<{ key: string; value: unknown }>(
        `SELECT key, value FROM settings
          WHERE business_id = $1 AND location_id IS NULL AND key = ANY($2::text[])`,
        [businessId, SNAPSHOT_SETTING_KEYS],
      ),
      effectiveFeatures(businessId),
    ]);

  const locationsByUser = new Map<string, string[]>();
  for (const row of assignRes.rows) {
    const list = locationsByUser.get(row.user_id) ?? [];
    list.push(row.location_id);
    locationsByUser.set(row.user_id, list);
  }

  return {
    version: PAIRING_SNAPSHOT_VERSION,
    business: bizRes.rows[0],
    location: locRes.rows[0],
    siteDevice,
    users: userRes.rows.map((u) => ({
      id: u.id,
      role: u.role,
      fullName: u.full_name,
      email: u.email,
      permissions: u.permissions ?? {},
      pinHash: u.pin_hash,
      passwordHash: u.password_hash,
      platformUserEmail: u.pu_email,
      platformUserFullName: u.pu_full_name,
      platformUserPasswordHash: u.pu_password_hash,
      locationIds: locationsByUser.get(u.id) ?? [],
    })),
    accounts: accountRes.rows.map((a) => ({
      id: a.id,
      parentCode: a.parent_code,
      code: a.code,
      name: a.name,
      type: a.type,
    })),
    menu: {
      categories: catRes.rows.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sort_order,
        isActive: c.is_active,
      })),
      items: itemRes.rows.map((i) => ({
        id: i.id,
        categoryId: i.category_id,
        name: i.name,
        description: i.description,
        sku: i.sku,
        // Keep PostgreSQL bigint as text through JSON; converting to Number
        // would silently round sufficiently large Rial values.
        price: i.price,
        imageUrl: i.image_url,
        imageMediaId: i.image_media_id,
        isActive: i.is_active,
        sortOrder: i.sort_order,
      })),
      mediaAssets: mediaAssetRes.rows.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        fileName: asset.file_name,
        mimeType: asset.mime_type,
        byteSize: asset.byte_size,
        storageKey: asset.storage_key,
        sha256: asset.sha256,
      })),
      modifierGroups: modifierGroupRes.rows.map((group) => ({
        id: group.id,
        name: group.name,
        minSelect: group.min_select,
        maxSelect: group.max_select,
        isActive: group.is_active,
        sortOrder: group.sort_order,
      })),
      modifiers: modifierRes.rows.map((modifier) => ({
        id: modifier.id,
        groupId: modifier.group_id,
        name: modifier.name,
        priceDelta: modifier.price_delta,
        isActive: modifier.is_active,
        sortOrder: modifier.sort_order,
      })),
      itemModifierGroups: itemModifierRes.rows.map((link) => ({
        menuItemId: link.menu_item_id,
        modifierGroupId: link.modifier_group_id,
        minSelectOverride: link.min_select_override,
        maxSelectOverride: link.max_select_override,
        sortOrder: link.sort_order,
        isActive: link.is_active,
      })),
    },
    diningTables: diningRes.rows.map((table) => ({
      id: table.id,
      name: table.name,
      zone: table.zone,
      capacity: table.capacity,
      sortOrder: table.sort_order,
      isActive: table.is_active,
    })),
    inventory: {
      items: inventoryRes.rows.map((item) => ({
        id: item.id,
        name: item.name,
        sku: item.sku,
        unit: item.unit,
        reorderLevel: item.reorder_level,
        averageCost: item.avg_cost,
        purchaseUnit: item.purchase_unit,
        purchaseUnitFactor: item.purchase_unit_factor,
        carryingValueRial: item.carrying_value_rial,
        isProduced: item.is_produced,
        isActive: item.is_active,
      })),
      menuIngredients: menuIngredientRes.rows.map((ingredient) => ({
        menuItemId: ingredient.menu_item_id,
        inventoryItemId: ingredient.inventory_item_id,
        quantity: ingredient.quantity,
      })),
      modifierIngredients: modifierIngredientRes.rows.map((ingredient) => ({
        modifierId: ingredient.modifier_id,
        inventoryItemId: ingredient.inventory_item_id,
        quantityDelta: ingredient.quantity_delta,
      })),
    },
    paymentMethods: paymentMethodRes.rows.map((method) => ({
      id: method.id,
      code: method.code,
      name: method.name,
      settlement: method.settlement,
      sortOrder: method.sort_order,
      isActive: method.is_active,
      isBuiltin: method.is_builtin,
      opensDrawer: method.opens_drawer,
      requiresReference: method.requires_reference,
    })),
    settings: settingRes.rows.map((s) => ({ key: s.key, value: s.value })),
    dataClassification: PAIRING_DATA_CLASSIFICATION,
    features,
    syncToken,
  };
}

const PAIRING_DATA_CLASSIFICATION = {
  bootstrapMasterData: [
    "business identity and selected location",
    "active users, location assignments, and credential hashes",
    "chart of accounts",
    "feature entitlements and selected operational settings",
    "menu categories, items, modifier groups, modifiers, and recipes",
    "dining tables (availability state resets locally)",
    "inventory item catalogue (not stock balances or lots)",
    "named payment methods",
    "site-device identity and one-time sync credential",
  ],
  ongoingDomainEvents: [
    "order.created",
    "order.item_added",
    "order.item_status_changed",
  ],
  siteLocalOperationalData: [
    "embedded PostgreSQL files and local backup destinations",
    "desktop identity, secrets, certificates, LAN gateway, logs, and firewall preference",
    "IndexedDB offline mutation queue",
    "printer and print-connector machine configuration",
  ],
  centralOnlyData: [
    "platform administrators, impersonation grants, plans, wallet billing, and global feature catalogue",
    "cloud media/update/backup distribution credentials",
    "cross-business support and platform audit data",
  ],
  notYetReplicated: [
    "historical/full orders, tenders, payments, refunds, reservations, and shifts",
    "journal entries, fiscal periods, bank reconciliation, payroll, tax filings, and accounting documents",
    "stock balances, lots, movements, counts, purchases, suppliers, production, and transfers",
    "customers, CRM activity, loyalty, campaigns, coupons, and Growth/Marketing history",
    "website content, WooCommerce mappings/outbox, WordPress, Holoo, API/MCP, and other integration state",
    "media binaries and media-library history",
    "changes to bootstrap master data after pairing unless represented by an event listed above",
  ],
} satisfies PairingSnapshot["dataClassification"];

/**
 * The settings a till needs to operate, and nothing else. Backup destinations
 * and rollup/sync targets are machine-specific, and wizard progress is
 * recomputed on the local side (see applyPairingSnapshot), so none of them
 * travel.
 */
const SNAPSHOT_SETTING_KEYS = [
  SETTING_KEYS.businessPrefs,
  SETTING_KEYS.businessProfile,
  SETTING_KEYS.costing,
  SETTING_KEYS.tax,
  SETTING_KEYS.pricing,
];
