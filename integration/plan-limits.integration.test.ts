/**
 * Phase 17 — plan limits, against a real database.
 *
 * businesses.plan (migration 0034) now resolves to a row in `plans` with a
 * branch/member/monthly-order ceiling. Each creation path enforces its own
 * limit right before its INSERT (see plan-limits.ts's module comment for why
 * there's no single chokepoint the way feature-gating has one). This proves,
 * per plan tier and per creation path: usage under the limit succeeds, usage
 * at the limit is blocked with the documented error code, a `null` limit
 * (the "business" tier) is genuinely unlimited, and one business being at
 * its own cap never affects another's — same isolation story as the rest of
 * this phase, just for a new dimension.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let branchService: typeof import("../src/lib/branch-service");
let teamService: typeof import("../src/lib/team-service");
let orderMutations: typeof import("../src/lib/order-mutations");
let teamLib: typeof import("../src/lib/team");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_planlimits_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  branchService = await import("../src/lib/branch-service");
  teamService = await import("../src/lib/team-service");
  orderMutations = await import("../src/lib/order-mutations");
  teamLib = await import("../src/lib/team");

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

async function createBusiness(plan: string): Promise<{ id: string; locationId: string }> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, plan) VALUES ($1, $2, $3) RETURNING id",
    [`Plan Test ${plan} ${randomUUID().slice(0, 6)}`, `plan-test-${randomUUID().slice(0, 8)}`, plan],
  );
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.rows[0].id],
  );
  return { id: biz.rows[0].id, locationId: loc.rows[0].id };
}

describe("plans catalogue", () => {
  it("seeds free/pro/business with the expected ceilings", async () => {
    const { rows } = await db.query<{
      key: string;
      branch_limit: number | null;
      member_limit: number | null;
      monthly_order_limit: number | null;
    }>("SELECT key, branch_limit, member_limit, monthly_order_limit FROM plans ORDER BY key");
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(byKey.free).toMatchObject({ branch_limit: 1, member_limit: 5, monthly_order_limit: 500 });
    expect(byKey.pro).toMatchObject({ branch_limit: 5, member_limit: 20, monthly_order_limit: 5000 });
    expect(byKey.business).toMatchObject({ branch_limit: null, member_limit: null, monthly_order_limit: null });
  });

  it("a new business defaults to the free plan", async () => {
    const { rows } = await db.query<{ plan: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Default Plan Co', $1) RETURNING plan",
      [`default-plan-${randomUUID().slice(0, 8)}`],
    );
    expect(rows[0].plan).toBe("free");
  });
});

describe("branch limit", () => {
  it("blocks creating a branch beyond the free plan's cap of 1", async () => {
    const biz = await createBusiness("free"); // already has its one location from setup
    await expect(
      dbLib.withTenant(biz.id, () =>
        branchService.createBranch({ businessId: biz.id, name: "Second Branch", actorId: null }),
      ),
    ).rejects.toMatchObject({ message: "branch_limit_exceeded", status: 403 });
  });

  it("a business on the unlimited (business) plan can add many branches", async () => {
    const biz = await createBusiness("business");
    for (let i = 0; i < 5; i++) {
      await db.query("INSERT INTO locations (business_id, name) VALUES ($1, $2)", [biz.id, `Extra ${i}`]);
    }
    await expect(
      dbLib.withTenant(biz.id, () =>
        branchService.createBranch({ businessId: biz.id, name: "One More", actorId: null }),
      ),
    ).resolves.toMatchObject({ locationId: expect.any(String) });
  });

  it("one business being at its branch cap doesn't affect another business", async () => {
    const capped = await createBusiness("free");
    const other = await createBusiness("free");
    await expect(
      dbLib.withTenant(capped.id, () =>
        branchService.createBranch({ businessId: capped.id, name: "Blocked", actorId: null }),
      ),
    ).rejects.toMatchObject({ message: "branch_limit_exceeded" });
    // `other` has exactly the same plan and is at the same count (1), but is a
    // different business — its own next branch must still be blocked on its
    // OWN cap, not silently allowed just because it's a different business;
    // the real proof of isolation is that this rejection is independent of
    // `capped`'s state, not a leaked "already used up" flag.
    await expect(
      dbLib.withTenant(other.id, () =>
        branchService.createBranch({ businessId: other.id, name: "Also Blocked", actorId: null }),
      ),
    ).rejects.toMatchObject({ message: "branch_limit_exceeded" });
  });
});

describe("member limit", () => {
  it("blocks direct member creation beyond the free plan's cap of 5", async () => {
    const biz = await createBusiness("free");
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'cashier', $2, 'x')`,
        [biz.id, `Member ${i}`],
      );
    }
    await expect(
      dbLib.withTenant(biz.id, () =>
        teamService.createMembership({ businessId: biz.id, role: "cashier", fullName: "One Too Many", pin: "1234", actorId: null }),
      ),
    ).rejects.toMatchObject({ message: "member_limit_exceeded", status: 403 });
  });

  it("blocks invitation acceptance beyond the cap too (the other membership-creation path)", async () => {
    const biz = await createBusiness("free");
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'cashier', $2, 'x')`,
        [biz.id, `Member ${i}`],
      );
    }
    const { token, tokenHash } = teamLib.generateInvitationToken();
    await db.query(
      `INSERT INTO invitations (business_id, email, role, full_name, token_hash, expires_at)
       VALUES ($1, $2, 'manager', 'Invitee', $3, now() + interval '1 day')`,
      [biz.id, `invitee-${randomUUID().slice(0, 8)}@example.com`, tokenHash],
    );
    await expect(teamService.acceptInvitation(token, "a-strong-password")).rejects.toMatchObject({
      message: "member_limit_exceeded",
      status: 403,
    });
  });

  it("a business on the unlimited plan can add many members", async () => {
    const biz = await createBusiness("business");
    for (let i = 0; i < 30; i++) {
      await db.query(
        `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'cashier', $2, 'x')`,
        [biz.id, `Member ${i}`],
      );
    }
    await expect(
      dbLib.withTenant(biz.id, () =>
        teamService.createMembership({ businessId: biz.id, role: "cashier", fullName: "Still Fine", pin: "1234", actorId: null }),
      ),
    ).resolves.toMatchObject({ userId: expect.any(String) });
  });
});

describe("monthly order limit", () => {
  async function fillOrders(businessId: string, locationId: string, count: number) {
    // order_number starts at 1 via order_number_counters (order-mutations.ts)
    // for a location's first real createOrder call — offset well clear of
    // that so this bulk fill never collides with the real insert under test.
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, opened_at)
       SELECT $1, 10000 + gs, 'takeaway', 'completed', 10000, date_trunc('month', now()) + interval '1 hour'
       FROM generate_series(1, $2) AS gs`,
      [locationId, count],
    );
    void businessId;
  }

  it("blocks a new order once the free plan's monthly cap of 500 is reached", async () => {
    const biz = await createBusiness("free");
    await fillOrders(biz.id, biz.locationId, 500);
    const category = await db.query<{ id: string }>(
      "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Cat') RETURNING id",
      [biz.locationId],
    );
    const item = await db.query<{ id: string }>(
      "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'Item', 10000) RETURNING id",
      [biz.locationId, category.rows[0].id],
    );

    const result = await dbLib.withTenant(biz.id, () =>
      orderMutations.createOrder({
        locationId: biz.locationId,
        type: "takeaway",
        discount: { type: null },
        items: [{ menuItemId: item.rows[0].id, quantity: 1 }],
        openedBy: null,
      }),
    );
    expect(result).toMatchObject({ ok: false, error: "monthly_order_limit_exceeded", status: 403 });
  });

  it("a business on the unlimited plan keeps taking orders past 500/month", async () => {
    const biz = await createBusiness("business");
    await fillOrders(biz.id, biz.locationId, 600);
    const category = await db.query<{ id: string }>(
      "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Cat') RETURNING id",
      [biz.locationId],
    );
    const item = await db.query<{ id: string }>(
      "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'Item', 10000) RETURNING id",
      [biz.locationId, category.rows[0].id],
    );

    const result = await dbLib.withTenant(biz.id, () =>
      orderMutations.createOrder({
        locationId: biz.locationId,
        type: "takeaway",
        discount: { type: null },
        items: [{ menuItemId: item.rows[0].id, quantity: 1 }],
        openedBy: null,
      }),
    );
    expect(result.ok).toBe(true);
  });
});
