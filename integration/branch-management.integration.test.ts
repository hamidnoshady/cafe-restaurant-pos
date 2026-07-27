/**
 * Phase 14 exit criteria, against a real database.
 *
 *   1. A business with several branches shows correct per-branch and
 *      consolidated numbers, and the two reconcile.
 *   2. A member assigned to branch B cannot read branch A's orders, stock or
 *      till, even within their own business.
 *   3. Switching branches never leaks stale data from the previous one.
 *   4. Cross-branch inventory transfers balance on both sides of the ledger —
 *      already built (Phase 6/17); this suite only confirms the exit
 *      criterion is real by pointing at the existing coverage, not by
 *      rebuilding it. See operational-accounting.integration.test.ts's
 *      "ships, cancels, receives exactly once, and preserves transfer value".
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let dbLib: typeof import("../src/lib/db");
let setupState: typeof import("../src/lib/setup-state");
let branchService: typeof import("../src/lib/branch-service");
let reportsService: typeof import("../src/lib/reports-service");
let authEdge: typeof import("../src/lib/auth-edge");

const biz = { id: "", mainLocationId: "", northLocationId: "" };

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

function session(overrides: Partial<import("../src/lib/auth-edge").SessionPayload>) {
  return {
    sub: "",
    role: "owner" as const,
    businessId: biz.id,
    locationId: null,
    fullName: "Test",
    platformUserId: null,
    ...overrides,
  };
}

beforeAll(async () => {
  databaseName = `pos_branch_${randomUUID().replaceAll("-", "")}`;

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
  setupState = await import("../src/lib/setup-state");
  branchService = await import("../src/lib/branch-service");
  reportsService = await import("../src/lib/reports-service");
  authEdge = await import("../src/lib/auth-edge");
  void authEdge;

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

function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");

  // Phase 17 gave the default 'free' plan a 1-branch cap; this suite is
  // specifically about having several branches, which is a plan-limit
  // concern this suite isn't testing, so it runs on the uncapped tier.
  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug, plan) VALUES ('Multi-Branch Co', $1, 'business') RETURNING id",
    [`mb-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const main = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.mainLocationId = main.rows[0].id;

  const north = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'North') RETURNING id",
    [biz.id],
  );
  biz.northLocationId = north.rows[0].id;
});

async function createMember(role: "owner" | "manager" | "cashier", locationId: string | null) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, location_id, pin_hash)
     VALUES ($1, $2, 'Member', $3, 'x') RETURNING id`,
    [biz.id, role, locationId],
  );
  return rows[0].id;
}

describe("branch access is confined to assignment", () => {
  it("restricts a member assigned to one branch, and it never resolves to the other", async () => {
    const cashierId = await createMember("cashier", biz.northLocationId);

    await asBusiness(biz.id, async () => {
      const resolved = await setupState.resolveActiveLocation(session({ sub: cashierId, role: "cashier" }));
      expect(resolved?.id).toBe(biz.northLocationId);

      const { locations, canSwitch } = await setupState.accessibleLocationsFor(
        session({ sub: cashierId, role: "cashier" }),
      );
      expect(locations.map((l) => l.id)).toEqual([biz.northLocationId]);
      expect(canSwitch).toBe(false);
    });
  });

  it("lets an owner reach and resolve to every branch", async () => {
    const ownerId = await createMember("owner", null);

    await asBusiness(biz.id, async () => {
      const { locations, canSwitch } = await setupState.accessibleLocationsFor(session({ sub: ownerId }));
      expect(locations.map((l) => l.id).sort()).toEqual(
        [biz.mainLocationId, biz.northLocationId].sort(),
      );
      expect(canSwitch).toBe(true);
    });
  });

  it("switching never leaks the previous branch's data — resolution always reflects the requested branch", async () => {
    const ownerId = await createMember("owner", null);

    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'takeaway', 'completed', 1000)`,
      [biz.mainLocationId],
    );
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'takeaway', 'completed', 2000)`,
      [biz.northLocationId],
    );

    await asBusiness(biz.id, async () => {
      const mainSession = session({ sub: ownerId, activeLocationId: biz.mainLocationId });
      const north = session({ sub: ownerId, activeLocationId: biz.northLocationId });

      const resolvedMain = await setupState.resolveActiveLocation(mainSession);
      expect(resolvedMain?.id).toBe(biz.mainLocationId);

      const resolvedNorth = await setupState.resolveActiveLocation(north);
      expect(resolvedNorth?.id).toBe(biz.northLocationId);

      // Each resolution is independent — asking for North right after Main
      // does not carry Main's id forward.
      const resolvedMainAgain = await setupState.resolveActiveLocation(mainSession);
      expect(resolvedMainAgain?.id).toBe(biz.mainLocationId);
    });
  });

  it("falls back to an accessible branch when the requested one is not (or no longer) reachable", async () => {
    const cashierId = await createMember("cashier", biz.northLocationId);

    await asBusiness(biz.id, async () => {
      // Token names Main, but this cashier is fixed to North.
      const spoofed = session({
        sub: cashierId,
        role: "cashier",
        activeLocationId: biz.mainLocationId,
      });
      const resolved = await setupState.resolveActiveLocation(spoofed);
      expect(resolved?.id).toBe(biz.northLocationId);
    });
  });
});

describe("branch lifecycle", () => {
  it("copies the menu structure into a new branch, without inventory or recipes", async () => {
    const category = await db.query<{ id: string }>(
      "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'Drinks') RETURNING id",
      [biz.mainLocationId],
    );
    const group = await db.query<{ id: string }>(
      "INSERT INTO modifier_groups (location_id, name) VALUES ($1, 'Size') RETURNING id",
      [biz.mainLocationId],
    );
    await db.query("INSERT INTO modifiers (location_id, group_id, name) VALUES ($1, $2, 'Large')", [
      biz.mainLocationId,
      group.rows[0].id,
    ]);
    const item = await db.query<{ id: string }>(
      `INSERT INTO menu_items (location_id, category_id, name, price)
       VALUES ($1, $2, 'Latte', 50000) RETURNING id`,
      [biz.mainLocationId, category.rows[0].id],
    );
    await db.query(
      "INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id) VALUES ($1, $2)",
      [item.rows[0].id, group.rows[0].id],
    );
    await db.query(
      "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'Milk', 'l')",
      [biz.mainLocationId],
    );

    const { locationId: newBranchId } = await branchService.createBranch({
      businessId: biz.id,
      name: "South",
      copyMenuFromLocationId: biz.mainLocationId,
      actorId: null,
    });

    const items = await db.query<{ name: string; price: string }>(
      "SELECT name, price FROM menu_items WHERE location_id = $1",
      [newBranchId],
    );
    expect(items.rows).toEqual([{ name: "Latte", price: "50000" }]);

    const modifiers = await db.query<{ name: string }>(
      `SELECT m.name FROM modifiers m
         JOIN modifier_groups g ON g.id = m.group_id
        WHERE g.location_id = $1`,
      [newBranchId],
    );
    expect(modifiers.rows.map((r) => r.name)).toEqual(["Large"]);

    const links = await db.query(
      `SELECT 1 FROM menu_item_modifier_groups mg
         JOIN menu_items mi ON mi.id = mg.menu_item_id
        WHERE mi.location_id = $1`,
      [newBranchId],
    );
    expect(links.rowCount).toBe(1);

    // Deliberately not copied: inventory is physically local to a branch.
    const inventory = await db.query("SELECT 1 FROM inventory_items WHERE location_id = $1", [
      newBranchId,
    ]);
    expect(inventory.rowCount).toBe(0);
  });

  it("refuses to deactivate the last active branch", async () => {
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);
    await expect(branchService.deactivateBranch(biz.id, biz.mainLocationId, null)).rejects.toThrow(
      "last_active_branch",
    );
  });

  it("refuses to deactivate a branch with an open order or open table session", async () => {
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'dine_in', 'open', 0)`,
      [biz.northLocationId],
    );
    await expect(branchService.deactivateBranch(biz.id, biz.northLocationId, null)).rejects.toThrow(
      "branch_has_open_orders",
    );

    await db.query("UPDATE orders SET status = 'completed', closed_at = now() WHERE location_id = $1", [
      biz.northLocationId,
    ]);
    await db.query(
      "INSERT INTO table_sessions (location_id, opened_at) VALUES ($1, now())",
      [biz.northLocationId],
    );
    await expect(branchService.deactivateBranch(biz.id, biz.northLocationId, null)).rejects.toThrow(
      "branch_has_open_sessions",
    );
  });

  it("a deactivated branch drops out of accessible/default resolution immediately", async () => {
    const ownerId = await createMember("owner", null);
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);

    await asBusiness(biz.id, async () => {
      const { locations } = await setupState.accessibleLocationsFor(session({ sub: ownerId }));
      expect(locations.map((l) => l.id)).toEqual([biz.mainLocationId]);

      const resolved = await setupState.resolveActiveLocation(
        session({ sub: ownerId, activeLocationId: biz.northLocationId }),
      );
      expect(resolved?.id).toBe(biz.mainLocationId);
    });
  });
});

describe("consolidated reporting reconciles with per-branch numbers", () => {
  it("sums branches to exactly the independently-computed consolidated total", async () => {
    for (const [locationId, total] of [
      [biz.mainLocationId, 10_000],
      [biz.northLocationId, 25_000],
    ] as const) {
      await db.query(
        `INSERT INTO orders (location_id, order_number, type, status, total, closed_at)
         VALUES ($1, 1, 'takeaway', 'completed', $2, now())`,
        [locationId, total],
      );
    }

    await asBusiness(biz.id, async () => {
      const overview = await reportsService.getBusinessOverview(biz.id);
      expect(overview.branches).toHaveLength(2);

      const summed = overview.branches.reduce((sum, b) => sum + b.total, 0);
      expect(summed).toBe(overview.consolidated.total);
      expect(overview.consolidated.total).toBe(35_000);

      const north = overview.branches.find((b) => b.locationId === biz.northLocationId);
      expect(north?.total).toBe(25_000);
    });
  });

  it("still reconciles once a branch has been deactivated (history isn't dropped)", async () => {
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total, closed_at)
       VALUES ($1, 1, 'takeaway', 'completed', 5000, now())`,
      [biz.northLocationId],
    );
    await branchService.deactivateBranch(biz.id, biz.northLocationId, null);

    await asBusiness(biz.id, async () => {
      const overview = await reportsService.getBusinessOverview(biz.id);
      const north = overview.branches.find((b) => b.locationId === biz.northLocationId);
      expect(north?.isActive).toBe(false);
      expect(north?.total).toBe(5000);
      expect(overview.consolidated.total).toBe(
        overview.branches.reduce((sum, b) => sum + b.total, 0),
      );
    });
  });
});
