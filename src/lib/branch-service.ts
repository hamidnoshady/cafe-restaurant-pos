/**
 * Phase 14 — branch (location) lifecycle within one business.
 *
 * Not to be confused with the Phase 9 `rollup_locations` registry: that is
 * cross-*server* (each branch's own on-premise server pushing to a central
 * one). This is cross-*row*, within one database, one business, RLS-scoped —
 * the multi-branch story for a business hosted on the shared platform.
 *
 * DB-touching, so not unit-tested directly per repo convention; the pure
 * access rules it composes with live in location-access.ts.
 */
import { getPool, query } from "./db";
import { activeBranchCount, planLimitsFor } from "./plan-limits";

export class BranchError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  isActive: boolean;
  createdAt: string;
}

interface BranchRow extends Record<string, unknown> {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  is_active: boolean;
  created_at: Date;
}

function toBranch(row: BranchRow): Branch {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    phone: row.phone,
    timezone: row.timezone,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
  };
}

/** Every branch of a business, active and inactive, for the management screen. */
export async function listBranches(businessId: string): Promise<Branch[]> {
  const { rows } = await query<BranchRow>(
    `SELECT id, name, address, phone, timezone, is_active, created_at
       FROM locations WHERE business_id = $1 ORDER BY created_at`,
    [businessId],
  );
  return rows.map(toBranch);
}

export interface CreateBranchInput {
  businessId: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  timezone?: string;
  /** An existing, active branch of the same business to copy the menu structure from. */
  copyMenuFromLocationId?: string | null;
  actorId: string | null;
}

/**
 * Copies menu categories, items, modifier groups/modifiers and the links
 * between them from one branch to another, remapping every id.
 *
 * Deliberately does NOT copy inventory items, recipes, or the chart of
 * accounts: inventory is physically local to a branch (a fresh branch has no
 * stock on hand to link a recipe's cost basis to), and the chart of accounts
 * is business-scoped already (Phase 14 decision — every branch of a business
 * shares one). Printers aren't copied either: hardware is physically at a
 * location, not a configuration to clone.
 */
async function copyMenuStructure(
  client: import("pg").PoolClient,
  fromLocationId: string,
  toLocationId: string,
): Promise<void> {
  const { rows: categories } = await client.query<{
    id: string;
    name: string;
    sort_order: number;
    is_active: boolean;
  }>(
    "SELECT id, name, sort_order, is_active FROM menu_categories WHERE location_id = $1",
    [fromLocationId],
  );
  const categoryIdMap = new Map<string, string>();
  if (categories.length > 0) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO menu_categories (location_id, name, sort_order, is_active)
       SELECT $1, name, sort_order, is_active
       FROM unnest($2::text[], $3::int[], $4::boolean[]) AS t(name, sort_order, is_active)
       RETURNING id`,
      [
        toLocationId,
        categories.map((c) => c.name),
        categories.map((c) => c.sort_order),
        categories.map((c) => c.is_active),
      ],
    );
    for (let i = 0; i < categories.length; i++) {
      categoryIdMap.set(categories[i].id, rows[i].id);
    }
  }

  const { rows: groups } = await client.query<{
    id: string;
    name: string;
    min_select: number;
    max_select: number;
  }>(
    "SELECT id, name, min_select, max_select FROM modifier_groups WHERE location_id = $1",
    [fromLocationId],
  );
  const groupIdMap = new Map<string, string>();
  if (groups.length > 0) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO modifier_groups (location_id, name, min_select, max_select)
       SELECT $1, name, min_select, max_select
       FROM unnest($2::text[], $3::int[], $4::int[]) AS t(name, min_select, max_select)
       RETURNING id`,
      [
        toLocationId,
        groups.map((g) => g.name),
        groups.map((g) => g.min_select),
        groups.map((g) => g.max_select),
      ],
    );
    for (let i = 0; i < groups.length; i++) {
      groupIdMap.set(groups[i].id, rows[i].id);
    }
  }

  const { rows: modifiers } = await client.query<{
    id: string;
    group_id: string;
    name: string;
    price_delta: string;
    is_active: boolean;
    sort_order: number;
  }>(
    `SELECT id, group_id, name, price_delta, is_active, sort_order FROM modifiers
      WHERE location_id = $1`,
    [fromLocationId],
  );
  const modifierIdMap = new Map<string, string>();
  const validModifiers = modifiers
    .map((m) => ({ ...m, newGroupId: groupIdMap.get(m.group_id) }))
    .filter((m) => m.newGroupId);

  if (validModifiers.length > 0) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO modifiers (location_id, group_id, name, price_delta, is_active, sort_order)
       SELECT $1, group_id::uuid, name, price_delta::numeric, is_active, sort_order
       FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::int[])
         AS t(group_id, name, price_delta, is_active, sort_order)
       RETURNING id`,
      [
        toLocationId,
        validModifiers.map((m) => m.newGroupId!),
        validModifiers.map((m) => m.name),
        validModifiers.map((m) => m.price_delta),
        validModifiers.map((m) => m.is_active),
        validModifiers.map((m) => m.sort_order),
      ],
    );
    for (let i = 0; i < validModifiers.length; i++) {
      modifierIdMap.set(validModifiers[i].id, rows[i].id);
    }
  }

  const { rows: items } = await client.query<{
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
       FROM menu_items WHERE location_id = $1`,
    [fromLocationId],
  );

  const validItems = items.map((item) => ({
    ...item,
    newCategoryId: item.category_id
      ? (categoryIdMap.get(item.category_id) ?? null)
      : null,
  }));
  const itemIdMap = new Map<string, string>();

  if (validItems.length > 0) {
    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO menu_items
         (location_id, category_id, name, description, sku, price, image_url, is_active, sort_order)
       SELECT $1, category_id::uuid, name, description, sku, price::numeric, image_url, is_active, sort_order
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::boolean[], $9::int[])
         AS t(category_id, name, description, sku, price, image_url, is_active, sort_order)
       RETURNING id`,
      [
        toLocationId,
        validItems.map((i) => i.newCategoryId),
        validItems.map((i) => i.name),
        validItems.map((i) => i.description),
        validItems.map((i) => i.sku),
        validItems.map((i) => i.price),
        validItems.map((i) => i.image_url),
        validItems.map((i) => i.is_active),
        validItems.map((i) => i.sort_order),
      ],
    );

    for (let i = 0; i < validItems.length; i++) {
      itemIdMap.set(validItems[i].id, inserted[i].id);
    }
  }

  const { rows: allLinks } = await client.query<{
    menu_item_id: string;
    modifier_group_id: string;
  }>(
    `SELECT mg.menu_item_id, mg.modifier_group_id
     FROM menu_item_modifier_groups mg
     JOIN menu_items mi ON mi.id = mg.menu_item_id
     WHERE mi.location_id = $1`,
    [fromLocationId],
  );

  const validLinks = allLinks
    .map((link) => ({
      newItemId: itemIdMap.get(link.menu_item_id),
      newGroupId: groupIdMap.get(link.modifier_group_id),
    }))
    .filter((link) => link.newItemId && link.newGroupId);

  if (validLinks.length > 0) {
    await client.query(
      `INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id)
       SELECT menu_item_id::uuid, modifier_group_id::uuid
       FROM unnest($1::text[], $2::text[]) AS t(menu_item_id, modifier_group_id)
       ON CONFLICT DO NOTHING`,
      [
        validLinks.map((l) => l.newItemId!),
        validLinks.map((l) => l.newGroupId!),
      ],
    );
  }
  // modifierIdMap is retained for symmetry with the other maps and potential
  // future use (e.g. copying modifier_ingredients); nothing reads it today
  // because ingredient links are deliberately not copied (see doc comment above).
  void modifierIdMap;
}

/** Creates a branch, optionally seeded with another branch's menu structure. */
export async function createBranch(
  input: CreateBranchInput,
): Promise<{ locationId: string }> {
  const name = input.name.trim();
  if (!name) throw new BranchError("missing_fields");

  const limits = await planLimitsFor(input.businessId);
  if (
    limits.branchLimit !== null &&
    (await activeBranchCount(input.businessId)) >= limits.branchLimit
  ) {
    throw new BranchError("branch_limit_exceeded", 403);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    if (input.copyMenuFromLocationId) {
      const { rows } = await client.query(
        "SELECT 1 FROM locations WHERE id = $1 AND business_id = $2 AND is_active",
        [input.copyMenuFromLocationId, input.businessId],
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new BranchError("source_branch_not_found", 404);
      }
    }

    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO locations (business_id, name, address, phone, timezone)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        input.businessId,
        name,
        input.address?.trim() || null,
        input.phone?.trim() || null,
        input.timezone ?? "Asia/Tehran",
      ],
    );
    const locationId = rows[0].id;

    if (input.copyMenuFromLocationId) {
      await copyMenuStructure(client, input.copyMenuFromLocationId, locationId);
    }

    await client.query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, 'branch.created', 'location', $4, $5)`,
      [
        input.businessId,
        locationId,
        input.actorId,
        // Separate parameter from location_id above: entity_id is text and
        // location_id is uuid, so Postgres can't type one shared placeholder.
        locationId,
        JSON.stringify({
          name,
          copiedMenuFrom: input.copyMenuFromLocationId ?? null,
        }),
      ],
    );

    await client.query("COMMIT");
    return { locationId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface UpdateBranchInput {
  businessId: string;
  locationId: string;
  actorId: string | null;
  name?: string;
  address?: string | null;
  phone?: string | null;
}

export async function updateBranch(input: UpdateBranchInput): Promise<void> {
  const { rows } = await query(
    `UPDATE locations
        SET name    = coalesce($3, name),
            address = CASE WHEN $4::boolean THEN $5 ELSE address END,
            phone   = CASE WHEN $6::boolean THEN $7 ELSE phone END
      WHERE id = $1 AND business_id = $2
      RETURNING id`,
    [
      input.locationId,
      input.businessId,
      input.name?.trim() || null,
      input.address !== undefined,
      input.address?.trim() || null,
      input.phone !== undefined,
      input.phone?.trim() || null,
    ],
  );
  if (rows.length === 0) throw new BranchError("not_found", 404);

  await query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id)
     VALUES ($1, $2, $3, 'branch.updated', 'location', $4)`,
    [input.businessId, input.locationId, input.actorId, input.locationId],
  );
}

/**
 * Deactivating a branch is a soft, reversible operation (Phase 14 decision):
 * it drops out of `businessLocations()`, so it stops being reachable for new
 * work — no member can switch into it, and it disappears from every "active
 * branch" default — while every historical row stays exactly where it is.
 *
 * Blocked while the branch has open orders or open table sessions: allowing
 * that would leave live operational state behind in a branch nobody can act
 * in anymore. Draft purchases and unposted stock counts are not blocked —
 * they have no live "in progress on the floor" quality — but they become
 * unreachable through the UI until the branch is reactivated.
 */
export async function deactivateBranch(
  businessId: string,
  locationId: string,
  actorId: string | null,
): Promise<void> {
  const activeCount = await query<{ n: string }>(
    "SELECT count(*) AS n FROM locations WHERE business_id = $1 AND is_active",
    [businessId],
  );
  if (Number(activeCount.rows[0].n) <= 1) {
    throw new BranchError("last_active_branch", 409);
  }

  const { rows: openOrders } = await query(
    "SELECT 1 FROM orders WHERE location_id = $1 AND status IN ('open', 'held') LIMIT 1",
    [locationId],
  );
  if (openOrders.length > 0)
    throw new BranchError("branch_has_open_orders", 409);

  const { rows: openSessions } = await query(
    "SELECT 1 FROM table_sessions WHERE location_id = $1 AND closed_at IS NULL LIMIT 1",
    [locationId],
  );
  if (openSessions.length > 0)
    throw new BranchError("branch_has_open_sessions", 409);

  const { rows } = await query(
    "UPDATE locations SET is_active = false WHERE id = $1 AND business_id = $2 RETURNING id",
    [locationId, businessId],
  );
  if (rows.length === 0) throw new BranchError("not_found", 404);

  await query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id)
     VALUES ($1, $2, $3, 'branch.deactivated', 'location', $4)`,
    [businessId, locationId, actorId, locationId],
  );
}

export async function reactivateBranch(
  businessId: string,
  locationId: string,
  actorId: string | null,
): Promise<void> {
  const { rows } = await query(
    "UPDATE locations SET is_active = true WHERE id = $1 AND business_id = $2 RETURNING id",
    [locationId, businessId],
  );
  if (rows.length === 0) throw new BranchError("not_found", 404);

  await query(
    `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id)
     VALUES ($1, $2, $3, 'branch.reactivated', 'location', $4)`,
    [businessId, locationId, actorId, locationId],
  );
}
