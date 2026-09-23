/**
 * Auto-freeing a table when its last order is settled.
 *
 * These are DB-orchestration functions, so the repo convention would normally
 * leave them to the integration suite. They get unit coverage anyway because
 * the *decision* they encode is the whole point of the feature and is easy to
 * get wrong in a way no type check catches: which orders count as still
 * holding the table, what happens to a table that is out of service, and
 * whether the session row is locked before the surviving orders are counted.
 * A fake client records the SQL, so each of those is asserted directly.
 */
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  releaseSessionWithoutOrders,
  releaseTableAfterOrderSettled,
} from "./table-session-service";

type Reply = { rows: unknown[] };

/**
 * A PoolClient stand-in that answers each query from a matcher list and keeps
 * the SQL it was asked, in order.
 */
function fakeClient(replies: { match: RegExp; rows: unknown[] }[]) {
  const seen: { sql: string; values: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []): Promise<Reply> => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    seen.push({ sql: normalized, values });
    const hit = replies.find((reply) => reply.match.test(normalized));
    return { rows: hit ? hit.rows : [] };
  });
  return { client: { query } as unknown as PoolClient, seen, query };
}

const SESSION = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const LOCATION = "33333333-3333-4333-8333-333333333333";
const TABLE = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

/** The happy path's replies: order is on a session, session is open and lockable. */
function releaseReplies(activeOrders: unknown[], freedTables = [{ table_id: TABLE }]) {
  return [
    { match: /SELECT table_session_id FROM orders/i, rows: [{ table_session_id: SESSION }] },
    { match: /FROM table_sessions WHERE id = \$1 .* FOR UPDATE/i, rows: [{ id: SESSION }] },
    { match: /FROM orders WHERE table_session_id = \$1 AND status IN/i, rows: activeOrders },
    { match: /UPDATE table_session_tables SET released_at/i, rows: freedTables },
  ];
}

describe("releaseTableAfterOrderSettled", () => {
  it("frees the table when the settled order was the last active one", async () => {
    const { client, seen } = fakeClient(releaseReplies([]));

    const result = await releaseTableAfterOrderSettled(client, LOCATION, ORDER, USER);

    expect(result).toEqual({ sessionId: SESSION });
    const closed = seen.find((q) => /UPDATE table_sessions SET status = 'closed'/.test(q.sql));
    expect(closed?.values).toEqual([SESSION, USER]);
    expect(seen.some((q) => /UPDATE table_session_tables SET released_at = now\(\)/.test(q.sql))).toBe(true);
    const freed = seen.find((q) => /UPDATE dining_tables SET status = 'free'/.test(q.sql));
    expect(freed?.values).toEqual([[TABLE]]);
  });

  it("leaves the table seated while another round is still open", async () => {
    // Two friends, two bills: paying one must not evict the other from the
    // table. This is the invariant table-separate-bills.integration.test.ts
    // guards end-to-end.
    const { client, seen } = fakeClient(releaseReplies([{ id: "other-order" }]));

    const result = await releaseTableAfterOrderSettled(client, LOCATION, ORDER, USER);

    expect(result).toBeNull();
    expect(seen.some((q) => /UPDATE dining_tables/.test(q.sql))).toBe(false);
    expect(seen.some((q) => /UPDATE table_sessions SET status = 'closed'/.test(q.sql))).toBe(false);
  });

  it("counts a held order as still holding the table", async () => {
    const { client, query } = fakeClient(releaseReplies([]));
    await releaseTableAfterOrderSettled(client, LOCATION, ORDER, USER);

    const activeCheck = query.mock.calls.find(([sql]) =>
      /FROM orders WHERE table_session_id/.test(String(sql).replace(/\s+/g, " ")),
    );
    // A parked order is an unfinished visit; only 'open' and 'held' may hold a
    // table, and 'completed'/'voided' must never keep one occupied.
    expect(String(activeCheck?.[0])).toContain("'open', 'held'");
  });

  it("never frees a table that is out of service", async () => {
    const { client, seen } = fakeClient(releaseReplies([]));
    await releaseTableAfterOrderSettled(client, LOCATION, ORDER, USER);

    const freed = seen.find((q) => /UPDATE dining_tables SET status = 'free'/.test(q.sql));
    expect(freed?.sql).toContain("status <> 'out_of_service'");
  });

  it("locks the session before counting what is left on it", async () => {
    // Without FOR UPDATE, two cashiers settling the table's last two orders
    // could each see the other's order as still open and neither would free
    // the table.
    const { client, seen } = fakeClient(releaseReplies([]));
    await releaseTableAfterOrderSettled(client, LOCATION, ORDER, USER);

    const lockAt = seen.findIndex((q) => /FROM table_sessions .* FOR UPDATE/.test(q.sql));
    const countAt = seen.findIndex((q) => /FROM orders WHERE table_session_id/.test(q.sql));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(countAt).toBeGreaterThan(lockAt);
  });

  it("does nothing for a takeaway order that has no table session", async () => {
    const { client, seen } = fakeClient([
      { match: /SELECT table_session_id FROM orders/i, rows: [{ table_session_id: null }] },
    ]);

    expect(await releaseTableAfterOrderSettled(client, LOCATION, ORDER, USER)).toBeNull();
    expect(seen).toHaveLength(1);
  });

  it("is idempotent: an already-closed session is not closed twice", async () => {
    // The lock query filters on status = 'open', so a re-run after a retry or
    // a duplicate sync event finds nothing and stops.
    const { client, seen } = fakeClient([
      { match: /SELECT table_session_id FROM orders/i, rows: [{ table_session_id: SESSION }] },
      { match: /FROM table_sessions WHERE id = \$1 .* FOR UPDATE/i, rows: [] },
    ]);

    expect(await releaseTableAfterOrderSettled(client, LOCATION, ORDER, USER)).toBeNull();
    // Nothing is written — the `FOR UPDATE` lock attempt is the last statement.
    expect(seen.some((q) => /^UPDATE /.test(q.sql))).toBe(false);
  });
});

describe("releaseSessionWithoutOrders", () => {
  it("frees a table that was seated but never ordered", async () => {
    const { client, seen } = fakeClient([
      { match: /FROM table_sessions WHERE id = \$1 .* FOR UPDATE/i, rows: [{ id: SESSION }] },
      { match: /FROM orders WHERE table_session_id/i, rows: [] },
      { match: /UPDATE table_session_tables SET released_at/i, rows: [{ table_id: TABLE }] },
    ]);

    await releaseSessionWithoutOrders(client, LOCATION, SESSION, USER);

    expect(seen.some((q) => /UPDATE dining_tables SET status = 'free'/.test(q.sql))).toBe(true);
  });

  it("refuses to release a table that still has a live order", async () => {
    // Otherwise this manual action would become a second way to make a table
    // look empty while money is still owed on it.
    const { client } = fakeClient([
      { match: /FROM table_sessions WHERE id = \$1 .* FOR UPDATE/i, rows: [{ id: SESSION }] },
      { match: /FROM orders WHERE table_session_id/i, rows: [{ id: ORDER }] },
    ]);

    await expect(releaseSessionWithoutOrders(client, LOCATION, SESSION, USER)).rejects.toMatchObject({
      code: "session_has_active_orders",
      status: 409,
    });
  });

  it("reports a missing or already-closed session as 404", async () => {
    const { client } = fakeClient([
      { match: /FROM table_sessions WHERE id = \$1 .* FOR UPDATE/i, rows: [] },
    ]);

    await expect(releaseSessionWithoutOrders(client, LOCATION, SESSION, USER)).rejects.toMatchObject({
      code: "session_not_found",
      status: 404,
    });
  });
});
