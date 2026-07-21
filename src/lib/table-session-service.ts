/**
 * Server-side table-session operations (DB-touching; not unit-tested directly,
 * per the repo convention). Pure calculations live in ./table-sessions and
 * ./orders — this module only orchestrates DB writes around them.
 */
import type { PoolClient } from "pg";
import { query } from "./db";
import { computeOrderTotals, type CartLine, type DiscountInput } from "./orders";
import type { Rial } from "./money";
import type { SplitLine } from "./table-sessions";

export interface OpenSessionInput {
  locationId: string;
  tableIds: string[];
  partySize?: number | null;
  guestName?: string | null;
  guestPhone?: string | null;
  reservationId?: string | null;
  openedBy: string | null;
}

/** Find the open session currently holding a table, if any. */
export async function getOpenSessionIdForTable(
  client: PoolClient,
  locationId: string,
  tableId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT ts.id
       FROM table_sessions ts
       JOIN table_session_tables tst ON tst.session_id = ts.id AND tst.released_at IS NULL
      WHERE ts.location_id = $1 AND ts.status = 'open' AND tst.table_id = $2
      LIMIT 1`,
    [locationId, tableId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Open a session on one or more free tables (seating a walk-in or reservation).
 * Locks the table rows, verifies each is seatable, creates the session +
 * memberships, and flips the tables to 'seated'. Throws {code} on conflict.
 */
export async function openSession(client: PoolClient, input: OpenSessionInput): Promise<{ id: string }> {
  const { locationId, tableIds, openedBy } = input;
  if (tableIds.length === 0) throw Object.assign(new Error("no_tables"), { code: "no_tables" });

  const { rows: tables } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM dining_tables
      WHERE location_id = $1 AND id = ANY($2::uuid[]) AND is_active
      FOR UPDATE`,
    [locationId, tableIds],
  );
  if (tables.length !== tableIds.length) {
    throw Object.assign(new Error("table_not_found"), { code: "table_not_found", status: 404 });
  }
  for (const t of tables) {
    if (t.status === "cleaning" || t.status === "out_of_service") {
      throw Object.assign(new Error("table_unavailable"), { code: "table_unavailable", status: 409 });
    }
    const existing = await getOpenSessionIdForTable(client, locationId, t.id);
    if (existing) throw Object.assign(new Error("table_occupied"), { code: "table_occupied", status: 409 });
  }

  const { rows: sessionRows } = await client.query<{ id: string }>(
    `INSERT INTO table_sessions
        (location_id, primary_table_id, party_size, guest_name, guest_phone, reservation_id, opened_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      locationId,
      tableIds[0],
      input.partySize ?? null,
      input.guestName ?? null,
      input.guestPhone ?? null,
      input.reservationId ?? null,
      openedBy,
    ],
  );
  const sessionId = sessionRows[0].id;

  for (const id of tableIds) {
    await client.query(
      "INSERT INTO table_session_tables (session_id, table_id) VALUES ($1, $2)",
      [sessionId, id],
    );
  }
  await client.query(
    "UPDATE dining_tables SET status = 'seated' WHERE id = ANY($1::uuid[])",
    [tableIds],
  );
  return { id: sessionId };
}

/**
 * Ensure a dine-in order has a session: reuse the table's open session or open
 * a fresh one. Returns the session id. Runs inside the caller's transaction.
 */
export async function ensureSessionForTable(
  client: PoolClient,
  locationId: string,
  tableId: string,
  openedBy: string | null,
  partySize?: number | null,
): Promise<string> {
  const existing = await getOpenSessionIdForTable(client, locationId, tableId);
  if (existing) return existing;
  const { id } = await openSession(client, {
    locationId,
    tableIds: [tableId],
    partySize: partySize ?? null,
    openedBy,
  });
  return id;
}

/** Add a free table to an open session (merge for a larger group). */
export async function mergeTableIntoSession(
  client: PoolClient,
  locationId: string,
  sessionId: string,
  tableId: string,
): Promise<void> {
  const { rows: sess } = await client.query<{ id: string }>(
    "SELECT id FROM table_sessions WHERE id = $1 AND location_id = $2 AND status = 'open' FOR UPDATE",
    [sessionId, locationId],
  );
  if (sess.length === 0) throw Object.assign(new Error("session_not_found"), { code: "session_not_found", status: 404 });

  const { rows: tbl } = await client.query<{ id: string; status: string }>(
    "SELECT id, status FROM dining_tables WHERE id = $1 AND location_id = $2 AND is_active FOR UPDATE",
    [tableId, locationId],
  );
  if (tbl.length === 0) throw Object.assign(new Error("table_not_found"), { code: "table_not_found", status: 404 });
  if (tbl[0].status === "cleaning" || tbl[0].status === "out_of_service") {
    throw Object.assign(new Error("table_unavailable"), { code: "table_unavailable", status: 409 });
  }
  const occupied = await getOpenSessionIdForTable(client, locationId, tableId);
  if (occupied) throw Object.assign(new Error("table_occupied"), { code: "table_occupied", status: 409 });

  // A previously-released membership row may exist (same PK) — revive it.
  await client.query(
    `INSERT INTO table_session_tables (session_id, table_id) VALUES ($1, $2)
     ON CONFLICT (session_id, table_id) DO UPDATE SET released_at = NULL, joined_at = now()`,
    [sessionId, tableId],
  );
  await client.query("UPDATE dining_tables SET status = 'seated' WHERE id = $1", [tableId]);
}

/** Mark the whole session as awaiting checkout; its tables show 'bill_requested'. */
export async function requestBill(client: PoolClient, locationId: string, sessionId: string): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    "UPDATE table_sessions SET bill_requested_at = COALESCE(bill_requested_at, now()) WHERE id = $1 AND location_id = $2 AND status = 'open' RETURNING id",
    [sessionId, locationId],
  );
  if (rows.length === 0) throw Object.assign(new Error("session_not_found"), { code: "session_not_found", status: 404 });
  await client.query(
    `UPDATE dining_tables SET status = 'bill_requested'
      WHERE id IN (SELECT table_id FROM table_session_tables WHERE session_id = $1 AND released_at IS NULL)
        AND status = 'seated'`,
    [sessionId],
  );
}

/**
 * Close a session (checkout). Releases its tables to 'cleaning' (needs-cleaning
 * step) and stamps closed_at/closed_by. Any still-open orders are left as-is
 * for the payment flow arriving in Phase 4 — closing here is the manual
 * end-of-visit action until payments post automatically.
 */
export async function closeSession(
  client: PoolClient,
  locationId: string,
  sessionId: string,
  closedBy: string | null,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    "UPDATE table_sessions SET status = 'closed', closed_at = now(), closed_by = $3 WHERE id = $1 AND location_id = $2 AND status = 'open' RETURNING id",
    [sessionId, locationId, closedBy],
  );
  if (rows.length === 0) throw Object.assign(new Error("session_not_found"), { code: "session_not_found", status: 404 });

  const { rows: freed } = await client.query<{ table_id: string }>(
    "UPDATE table_session_tables SET released_at = now() WHERE session_id = $1 AND released_at IS NULL RETURNING table_id",
    [sessionId],
  );
  const tableIds = freed.map((r) => r.table_id);
  if (tableIds.length > 0) {
    await client.query("UPDATE dining_tables SET status = 'cleaning' WHERE id = ANY($1::uuid[])", [tableIds]);
  }
  // Detach the reservation link's seated marker stays; nothing else to do.
}

export interface SessionBill {
  total: Rial;
  lines: { orderItemId: string; orderId: string; name: string; amount: Rial }[];
}

/**
 * Build the billable lines for a session across all its non-voided orders.
 * Each line's amount is that order line's post-discount, tax-inclusive total
 * (computed with the same {@link computeOrderTotals} used everywhere else), so
 * summed line amounts equal the session bill exactly.
 */
export async function computeSessionBill(sessionId: string): Promise<SessionBill> {
  const { rows: orders } = await query<{ id: string; discount_type: string | null; discount_value: string | null }>(
    "SELECT id, discount_type, discount_value FROM orders WHERE table_session_id = $1 AND status != 'voided' ORDER BY opened_at",
    [sessionId],
  );

  const lines: SessionBill["lines"] = [];
  let total = 0;
  for (const order of orders) {
    const { rows: items } = await query<{
      id: string;
      name_snapshot: string;
      unit_price: string;
      quantity: number;
      tax_rate: string;
      mod_deltas: string[] | null;
    }>(
      `SELECT oi.id, oi.name_snapshot, oi.unit_price, oi.quantity,
              COALESCE(mc.tax_rate, 0) AS tax_rate,
              ARRAY(SELECT price_delta FROM order_item_modifiers oim WHERE oim.order_item_id = oi.id) AS mod_deltas
         FROM order_items oi
         LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
         LEFT JOIN menu_categories mc ON mc.id = mi.category_id
        WHERE oi.order_id = $1 AND oi.status != 'voided'
        ORDER BY oi.created_at`,
      [order.id],
    );
    if (items.length === 0) continue;

    const cartLines: CartLine[] = items.map((it) => ({
      unitPrice: Number(it.unit_price),
      quantity: it.quantity,
      modifierDeltas: (it.mod_deltas ?? []).map(Number),
      taxRatePercent: Number(it.tax_rate),
    }));
    const discount: DiscountInput =
      order.discount_type === "percent" || order.discount_type === "amount"
        ? { type: order.discount_type, value: Number(order.discount_value ?? 0) }
        : { type: null };
    const totals = computeOrderTotals(cartLines, discount);
    totals.lines.forEach((lt, i) => {
      lines.push({ orderItemId: items[i].id, orderId: order.id, name: items[i].name_snapshot, amount: lt.lineTotal });
      total += lt.lineTotal;
    });
  }
  return { total, lines };
}

/** Assemble {@link SplitLine}s from a bill + an assignment map (itemId → guest index). */
export function billToSplitLines(bill: SessionBill, assignments: Record<string, number>): SplitLine[] {
  return bill.lines.map((l) => {
    const g = assignments[l.orderItemId];
    return { amount: l.amount, guest: Number.isInteger(g) ? g : null };
  });
}
