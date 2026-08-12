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
import { getPool, query, withoutTenantScope } from "./db";
import { effectiveFeatures } from "./features";
import {
  generatePairingCode,
  hashPairingCode,
  pairingCodeState,
  PAIRING_CODE_TTL_HOURS,
  type PairingCodeState,
} from "./pairing-codes";
import { PAIRING_SNAPSHOT_VERSION, type PairingSnapshot } from "./pairing-snapshot";
import { setServerSyncConfig } from "./server-sync";
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
 * Runs under the caller's platform scope (the route wraps it in
 * `withPlatformScope`), so no extra bypass is taken here.
 */
export async function issuePairingCode(
  businessId: string,
  issuedBy: string,
): Promise<{ code: string; summary: PairingCodeSummary } | { error: "no_location" }> {
  const { rows: locationRows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  const locationId = locationRows[0]?.id;
  if (!locationId) return { error: "no_location" };

  const code = generatePairingCode();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE install_pairing_codes SET revoked_at = now()
        WHERE business_id = $1 AND redeemed_at IS NULL AND revoked_at IS NULL`,
      [businessId],
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
): Promise<RedeemResult> {
  return withoutTenantScope("pairing-redeem", async () => {
    const client = await getPool().connect();
    let businessId: string;
    let locationId: string;
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

      await client.query(
        `UPDATE install_pairing_codes SET redeemed_at = now(), redeemed_ip = $2 WHERE id = $1`,
        [row.id, clientIp],
      );
      await client.query("COMMIT");
      businessId = row.business_id;
      locationId = row.location_id;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return { ok: true, snapshot: await buildPairingSnapshot(businessId, locationId) };
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
): Promise<PairingSnapshot> {
  const [bizRes, locRes, userRes, assignRes, accountRes, catRes, itemRes, settingRes, features] =
    await Promise.all([
      query<{ id: string; name: string; slug: string; timezone: string }>(
        `SELECT id, name, slug::text AS slug, timezone FROM businesses WHERE id = $1`,
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
        is_active: boolean;
        sort_order: number;
      }>(
        `SELECT id, category_id, name, description, sku, price, image_url, is_active, sort_order
           FROM menu_items WHERE location_id = $1 ORDER BY sort_order, name`,
        [locationId],
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

  // Minted here rather than reused: the local install needs a token it can
  // present to this server, and the plaintext of any existing one is
  // unrecoverable (only the hash is stored). Writing it through
  // setServerSyncConfig replaces the business's server_sync_tokens row, which
  // is correct — one paired laptop per business is the model.
  const syncToken = generateSyncToken();
  const existingSync = await query<{ value: { remoteUrl?: string; batchSize?: number } }>(
    `SELECT value FROM settings
      WHERE business_id = $1 AND location_id IS NULL AND key = $2`,
    [businessId, SETTING_KEYS.serverSyncConfig],
  );
  await setServerSyncConfig(businessId, {
    remoteUrl: existingSync.rows[0]?.value?.remoteUrl ?? "",
    token: syncToken,
    enabled: false,
    batchSize: existingSync.rows[0]?.value?.batchSize ?? 100,
  });

  return {
    version: PAIRING_SNAPSHOT_VERSION,
    business: bizRes.rows[0],
    location: locRes.rows[0],
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
        // bigint comes back as a string from node-postgres; money is integer
        // Rial and always well within Number.MAX_SAFE_INTEGER.
        price: Number(i.price),
        imageUrl: i.image_url,
        isActive: i.is_active,
        sortOrder: i.sort_order,
      })),
    },
    settings: settingRes.rows.map((s) => ({ key: s.key, value: s.value })),
    features,
    syncToken,
  };
}

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
