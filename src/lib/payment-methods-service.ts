/**
 * Payment ways, DB side (migration 0091). The rules live in
 * payment-methods.ts; this file only reads and writes rows, so per repo
 * convention it has no direct unit test.
 *
 * One thing here is worth knowing before changing it: `ensurePaymentMethods`
 * seeds a business's built-in ways on first read. Migration 0091 seeds every
 * business that existed when it ran, and `provisionBusiness` seeds every
 * business created after it — but a business can also arrive by a restored
 * backup or a branch pairing, and a till with an empty payment grid is a shop
 * that cannot take money. Seeding on read closes that off for good, and is a
 * no-op (one indexed count) on every subsequent call.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import {
  builtinPaymentMethodsFor,
  paymentMethodCodeFor,
  sortPaymentMethods,
  type PaymentMethodView,
  type PaymentSettlement,
  type ValidatedPaymentMethod,
} from "./payment-methods";

interface PaymentMethodRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  settlement: PaymentSettlement;
  sort_order: number;
  is_active: boolean;
  is_builtin: boolean;
  opens_drawer: boolean;
  requires_reference: boolean;
}

function toView(row: PaymentMethodRow): PaymentMethodView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    settlement: row.settlement,
    sortOrder: Number(row.sort_order),
    isActive: row.is_active,
    isBuiltin: row.is_builtin,
    opensDrawer: row.opens_drawer,
    requiresReference: row.requires_reference,
  };
}

const SELECT_COLUMNS =
  "id, code, name, settlement::text AS settlement, sort_order, is_active, is_builtin, opens_drawer, requires_reference";

/** Seeds the built-in ways if this business has none yet. Idempotent. */
export async function ensurePaymentMethods(businessId: string): Promise<void> {
  const { rows } = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM payment_methods WHERE business_id = $1",
    [businessId],
  );
  if (Number(rows[0]?.count ?? 0) > 0) return;

  const { rows: bizRows } = await query<{ industry: string }>("SELECT industry FROM businesses WHERE id = $1", [
    businessId,
  ]);
  const client = await getPool().connect();
  try {
    await seedPaymentMethods(client, businessId, bizRows[0]?.industry ?? "food_service");
  } finally {
    client.release();
  }
}

/**
 * Inserts a business's built-in ways. Used by provisioning (inside the
 * transaction that creates the business) and by the lazy seed above.
 */
export async function seedPaymentMethods(
  client: PoolClient,
  businessId: string,
  industry: string,
): Promise<void> {
  for (const method of builtinPaymentMethodsFor(industry)) {
    await client.query(
      `INSERT INTO payment_methods (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer)
       VALUES ($1, $2, $3, $4::payment_method, $5, true, $6)
       ON CONFLICT (business_id, code) DO NOTHING`,
      [businessId, method.code, method.name, method.settlement, method.sortOrder, method.opensDrawer],
    );
  }
}

export interface ListPaymentMethodsOptions {
  /** Checkout screens want only what they may offer; the settings tab wants everything. */
  includeInactive?: boolean;
}

export async function listPaymentMethods(
  businessId: string,
  options: ListPaymentMethodsOptions = {},
): Promise<PaymentMethodView[]> {
  await ensurePaymentMethods(businessId);
  const { rows } = await query<PaymentMethodRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM payment_methods
      WHERE business_id = $1 ${options.includeInactive ? "" : "AND is_active"}`,
    [businessId],
  );
  return sortPaymentMethods(rows.map(toView));
}

/**
 * The ways named by a checkout's tenders, keyed by id — how a route turns
 * "the cashier tapped these two buttons" into the settlements the ledger
 * posts. Ids that don't belong to this business simply don't come back, which
 * is what makes the caller's "every tender resolved" check an authorization
 * check too.
 */
export async function paymentMethodsByIds(
  businessId: string,
  ids: readonly string[],
): Promise<Map<string, PaymentMethodView>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await query<PaymentMethodRow>(
    `SELECT ${SELECT_COLUMNS} FROM payment_methods WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, unique],
  );
  return new Map(rows.map((row) => [row.id, toView(row)]));
}

/** The business's way with this code (`cash`, `card`, …), or null. */
export async function paymentMethodByCode(businessId: string, code: string): Promise<PaymentMethodView | null> {
  const { rows } = await query<PaymentMethodRow>(
    `SELECT ${SELECT_COLUMNS} FROM payment_methods WHERE business_id = $1 AND code = $2`,
    [businessId, code],
  );
  return rows[0] ? toView(rows[0]) : null;
}

export async function createPaymentMethod(
  businessId: string,
  input: ValidatedPaymentMethod,
): Promise<PaymentMethodView> {
  const existing = await listPaymentMethods(businessId, { includeInactive: true });
  const code = paymentMethodCodeFor(input.name, existing.map((method) => method.code));
  // Added ways land after everything already configured, so adding one never
  // reshuffles a grid the cashiers have learned.
  const sortOrder = existing.reduce((max, method) => Math.max(max, method.sortOrder), 0) + 10;
  const { rows } = await query<PaymentMethodRow>(
    `INSERT INTO payment_methods
       (business_id, code, name, settlement, sort_order, is_builtin, opens_drawer, requires_reference)
     VALUES ($1, $2, $3, $4::payment_method, $5, false, $6, $7)
     RETURNING ${SELECT_COLUMNS}`,
    [businessId, code, input.name, input.settlement, sortOrder, input.opensDrawer, input.requiresReference],
  );
  return toView(rows[0]);
}

export interface PaymentMethodPatch {
  name?: string;
  settlement?: PaymentSettlement;
  isActive?: boolean;
  opensDrawer?: boolean;
  requiresReference?: boolean;
}

export async function updatePaymentMethod(
  businessId: string,
  id: string,
  patch: PaymentMethodPatch,
): Promise<PaymentMethodView | null> {
  const { rows } = await query<PaymentMethodRow>(
    `UPDATE payment_methods
        SET name = coalesce($3, name),
            settlement = coalesce($4::payment_method, settlement),
            is_active = coalesce($5, is_active),
            opens_drawer = coalesce($6, opens_drawer),
            requires_reference = coalesce($7, requires_reference)
      WHERE business_id = $1 AND id = $2
      RETURNING ${SELECT_COLUMNS}`,
    [
      businessId,
      id,
      patch.name ?? null,
      patch.settlement ?? null,
      patch.isActive ?? null,
      patch.opensDrawer ?? null,
      patch.requiresReference ?? null,
    ],
  );
  return rows[0] ? toView(rows[0]) : null;
}

/** How many payments were taken this way — what makes a way undeletable. */
export async function paymentCountForMethod(businessId: string, id: string): Promise<number> {
  const { rows } = await query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM payments p
       JOIN locations l ON l.id = p.location_id
      WHERE l.business_id = $1 AND p.payment_method_id = $2`,
    [businessId, id],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function deletePaymentMethod(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    "DELETE FROM payment_methods WHERE business_id = $1 AND id = $2 AND NOT is_builtin",
    [businessId, id],
  );
  return rowCount === 1;
}

/**
 * Rewrites the display order from a list of ids — the whole order at once,
 * because reordering one row at a time would leave the grid half-shuffled if
 * the second call failed, and two rows could end up sharing a position. The
 * settings tab therefore sends every id; a way left out of the list keeps
 * whatever `sort_order` it had, which is only well-defined if the caller
 * meant to omit it.
 */
export async function reorderPaymentMethods(businessId: string, orderedIds: readonly string[]): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const [index, id] of orderedIds.entries()) {
      await client.query("UPDATE payment_methods SET sort_order = $3 WHERE business_id = $1 AND id = $2", [
        businessId,
        id,
        (index + 1) * 10,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
