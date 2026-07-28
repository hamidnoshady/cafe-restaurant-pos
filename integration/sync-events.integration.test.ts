/**
 * End-to-end coverage for the offline-queue flush engine (Phase 5) and the
 * server-to-server sync HTTP endpoints (Phase 11/17), against a real
 * Postgres database. Before this file, only the pure conflict-classification
 * function (offline-sync.test.ts) and token-resolution (
 * server-sync-tokens.integration.test.ts) were tested directly — nothing
 * drove applySyncEvent's actual idempotency/conflict behavior against real
 * rows, and nothing called the /api/server-sync/push and /pull route
 * handlers at all. That second gap is exactly the shape of bug Phase 17 had
 * to find by manual review (a cross-business leak in these same routes), so
 * this file also proves push/pull isolation holds.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";
import { createAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const APP_ROLE = "pos_sync_test_role";
const APP_PASSWORD = "sync-test-password";

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let syncEvents: typeof import("../src/lib/sync-events");
let serverSync: typeof import("../src/lib/server-sync");
let pushRoute: typeof import("../src/app/api/server-sync/push/route");
let pullRoute: typeof import("../src/app/api/server-sync/pull/route");

const bizA = { id: "", locationId: "", orderId: "", itemId: "", token: "token-for-a-0123456789" };
const bizB = { id: "", locationId: "", orderId: "", itemId: "", token: "token-for-b-9876543210" };

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_syncevents_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  // Connect the app modules as the unprivileged role, not the superuser this
  // repo's stock docker-compose/CI service makes the migration owner —
  // otherwise every RLS policy the push/pull isolation tests below depend on
  // would be silently bypassed, and the isolation assertions would pass
  // vacuously (see tenant-isolation.integration.test.ts's own warning about
  // exactly this).
  await createAppRole({ databaseUrl: urlFor(databaseName), roleName: APP_ROLE, password: APP_PASSWORD, quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName, { name: APP_ROLE, password: APP_PASSWORD });
  dbLib = await import("../src/lib/db");
  syncEvents = await import("../src/lib/sync-events");
  serverSync = await import("../src/lib/server-sync");
  pushRoute = await import("../src/app/api/server-sync/push/route");
  pullRoute = await import("../src/app/api/server-sync/pull/route");

  // Raw seeding/assertions use the superuser connection so fixtures for both
  // businesses can be created without being scoped to either tenant.
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function seedBusiness(name: string): Promise<{ businessId: string; locationId: string; orderId: string; itemId: string }> {
  const fixture = await db.query<{ business_id: string; location_id: string; order_id: string; item_id: string }>(
    `
    WITH business AS (
      INSERT INTO businesses(name, slug) VALUES ($1, $2) RETURNING id
    ), location AS (
      INSERT INTO locations(business_id, name) SELECT id, 'Main' FROM business RETURNING id, business_id
    ), new_order AS (
      INSERT INTO orders(location_id, order_number, status, subtotal, total)
      SELECT id, 1, 'open', 100, 100 FROM location RETURNING id, location_id
    ), new_item AS (
      INSERT INTO order_items(location_id, order_id, name_snapshot, unit_price, quantity, status)
      SELECT location_id, id, 'Coffee', 100, 1, 'sent' FROM new_order RETURNING id
    )
    SELECT location.business_id, new_order.location_id, new_order.id order_id, new_item.id item_id
      FROM location CROSS JOIN new_order CROSS JOIN new_item
    `,
    [name, `${name.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`],
  );
  const row = fixture.rows[0];
  return { businessId: row.business_id, locationId: row.location_id, orderId: row.order_id, itemId: row.item_id };
}

beforeEach(async () => {
  await db.query("DELETE FROM sync_events");
  await db.query("DELETE FROM server_sync_tokens");
  await db.query("DELETE FROM order_items");
  await db.query("DELETE FROM orders");
  await db.query("DELETE FROM locations");
  await db.query("DELETE FROM businesses");

  const a = await seedBusiness("Cafe A");
  bizA.id = a.businessId;
  bizA.locationId = a.locationId;
  bizA.orderId = a.orderId;
  bizA.itemId = a.itemId;

  const b = await seedBusiness("Cafe B");
  bizB.id = b.businessId;
  bizB.locationId = b.locationId;
  bizB.orderId = b.orderId;
  bizB.itemId = b.itemId;

  await dbLib.withTenant(bizA.id, () =>
    serverSync.setServerSyncConfig(bizA.id, { remoteUrl: "https://vps.example.com", token: bizA.token, enabled: true }),
  );
  await dbLib.withTenant(bizB.id, () =>
    serverSync.setServerSyncConfig(bizB.id, { remoteUrl: "https://vps.example.com", token: bizB.token, enabled: true }),
  );
});

describe("applySyncEvent — idempotency and conflict resolution against real rows", () => {
  it("replaying the same client_event_id is a no-op that returns the original outcome", async () => {
    const clientEventId = randomUUID();
    const event = {
      clientEventId,
      type: "order_item.status" as const,
      occurredAt: new Date().toISOString(),
      payload: { itemId: bizA.itemId, status: "preparing" },
    };

    const first = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(bizA.locationId, { userId: "u1", role: "kitchen" }, event),
    );
    expect(first).toMatchObject({ ok: true });

    const second = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(bizA.locationId, { userId: "u1", role: "kitchen" }, event),
    );
    expect(second).toMatchObject({ ok: true, duplicate: true });

    const { rows } = await dbLib.withTenant(bizA.id, () =>
      dbLib.query<{ status: string }>("SELECT status FROM order_items WHERE id = $1", [bizA.itemId]),
    );
    expect(rows[0].status).toBe("preparing");

    const { rows: seRows } = await db.query<{ count: string }>(
      "SELECT count(*)::text FROM sync_events WHERE location_id = $1 AND client_event_id = $2",
      [bizA.locationId, clientEventId],
    );
    expect(seRows[0].count).toBe("1");
  });

  it("a stale transition is flagged as a conflict and never mutates the row", async () => {
    // Legitimately progress sent -> preparing -> ready first (two kitchen bumps).
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(bizA.locationId, { userId: "u1", role: "kitchen" }, {
        clientEventId: randomUUID(),
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        payload: { itemId: bizA.itemId, status: "preparing" },
      }),
    );
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(bizA.locationId, { userId: "u1", role: "kitchen" }, {
        clientEventId: randomUUID(),
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        payload: { itemId: bizA.itemId, status: "ready" },
      }),
    );

    // A second device's queued "preparing" arrives after the item already reached "ready".
    const stale = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(bizA.locationId, { userId: "u2", role: "kitchen" }, {
        clientEventId: randomUUID(),
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        payload: { itemId: bizA.itemId, status: "preparing" },
      }),
    );
    expect(stale).toMatchObject({ ok: false, conflict: true });

    const { rows } = await dbLib.withTenant(bizA.id, () =>
      dbLib.query<{ status: string }>("SELECT status FROM order_items WHERE id = $1", [bizA.itemId]),
    );
    expect(rows[0].status).toBe("ready");
  });

  it("a location can only mutate its own business's item, never another's", async () => {
    const result = await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(bizA.locationId, { userId: "u1", role: "kitchen" }, {
        clientEventId: randomUUID(),
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        // bizB's item id, under bizA's location/tenant scope.
        payload: { itemId: bizB.itemId, status: "preparing" },
      }),
    );
    expect(result).toMatchObject({ ok: false, error: "item_not_found" });

    const { rows } = await dbLib.withTenant(bizB.id, () =>
      dbLib.query<{ status: string }>("SELECT status FROM order_items WHERE id = $1", [bizB.itemId]),
    );
    expect(rows[0].status).toBe("sent");
  });
});

function pushRequest(token: string, events: unknown[]): NextRequest {
  return new NextRequest("http://localhost/api/server-sync/push", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
}

function pullRequest(token: string, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/server-sync/pull${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

function statusEvent(locationId: string, itemId: string, status: string) {
  return {
    clientEventId: randomUUID(),
    type: "order_item.status",
    occurredAt: new Date().toISOString(),
    payload: { itemId, status },
    locationId,
    actorUserId: "remote-user",
    actorRole: "kitchen",
  };
}

describe("/api/server-sync/push and /pull — cross-business isolation", () => {
  it("applies a batch scoped entirely to the token's own business", async () => {
    const res = await pushRoute.POST(pushRequest(bizA.token, [statusEvent(bizA.locationId, bizA.itemId, "preparing")]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results[0]).toMatchObject({ ok: true });
  });

  it("rejects a batch mixing two businesses' locations, applying nothing", async () => {
    const res = await pushRoute.POST(
      pushRequest(bizA.token, [
        statusEvent(bizA.locationId, bizA.itemId, "preparing"),
        statusEvent(bizB.locationId, bizB.itemId, "preparing"),
      ]),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("mixed_business_locations");

    const { rows: aRows } = await db.query<{ status: string }>("SELECT status FROM order_items WHERE id = $1", [bizA.itemId]);
    const { rows: bRows } = await db.query<{ status: string }>("SELECT status FROM order_items WHERE id = $1", [bizB.itemId]);
    expect(aRows[0].status).toBe("sent");
    expect(bRows[0].status).toBe("sent");
  });

  it("rejects business A's token pushing events for business B's location", async () => {
    const res = await pushRoute.POST(pushRequest(bizA.token, [statusEvent(bizB.locationId, bizB.itemId, "preparing")]));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("location_business_mismatch");
  });

  it("pull never returns another business's events, even when both have some", async () => {
    // Pull only ever serves events that originated locally on this server
    // (origin='local', the default) — events ingested via push are tagged
    // 'remote' and are never bounced back (see the test below).
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(bizA.locationId, { userId: "u1", role: "kitchen" }, {
        clientEventId: randomUUID(),
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        payload: { itemId: bizA.itemId, status: "preparing" },
      }),
    );
    await dbLib.withTenant(bizB.id, () =>
      syncEvents.applySyncEvent(bizB.locationId, { userId: "u1", role: "kitchen" }, {
        clientEventId: randomUUID(),
        type: "order_item.status",
        occurredAt: new Date().toISOString(),
        payload: { itemId: bizB.itemId, status: "preparing" },
      }),
    );

    const pulledA = await (await pullRoute.GET(pullRequest(bizA.token))).json();
    const pulledB = await (await pullRoute.GET(pullRequest(bizB.token))).json();

    expect(pulledA.events).toHaveLength(1);
    expect(pulledA.events[0].locationId).toBe(bizA.locationId);
    expect(pulledB.events).toHaveLength(1);
    expect(pulledB.events[0].locationId).toBe(bizB.locationId);
  });

  it("never bounces a remote-origin event back out on the next pull", async () => {
    // Simulates business A having pulled an event that originated on the peer server.
    await dbLib.withTenant(bizA.id, () =>
      syncEvents.applySyncEvent(
        bizA.locationId,
        { userId: "peer", role: "kitchen" },
        {
          clientEventId: randomUUID(),
          type: "order_item.status",
          occurredAt: new Date().toISOString(),
          payload: { itemId: bizA.itemId, status: "preparing" },
        },
        "remote",
      ),
    );

    const pulled = await (await pullRoute.GET(pullRequest(bizA.token))).json();
    expect(pulled.events).toHaveLength(0);
  });

  it("rejects an unknown or missing bearer token", async () => {
    const res = await pushRoute.POST(pushRequest("not-a-real-token", [statusEvent(bizA.locationId, bizA.itemId, "preparing")]));
    expect(res.status).toBe(401);
  });
});
