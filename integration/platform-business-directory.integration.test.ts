/**
 * Server-side business directory (task section 6) + overview aggregation
 * (task section 3) — real-database coverage.
 *
 * `queryBusinesses` must filter/sort/paginate in SQL rather than returning the
 * whole table for the browser to slice, and `getPlatformOverview` must produce
 * its actionable counts in one batched round-trip. These are exercised against
 * a fresh migrated database so the WHERE/ORDER/LIMIT and the aggregate query
 * are proven against the real schema.
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
let platformService: typeof import("../src/lib/platform-service");
let overviewService: typeof import("../src/lib/platform-overview-service");

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

async function seedBusiness(opts: {
  name: string;
  slug: string;
  status?: "active" | "suspended" | "archived";
  plan?: string;
  industry?: string;
  createdAt?: string;
  withOrder?: boolean;
}): Promise<string> {
  const {
    name,
    slug,
    status = "active",
    plan = "free",
    industry = "food_service",
    createdAt,
    withOrder = false,
  } = opts;

  const business = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, plan, timezone, status, industry${createdAt ? ", created_at" : ""})
     VALUES ($1, $2, $3, 'Asia/Tehran', $4, $5${createdAt ? ", $6" : ""})
     RETURNING id`,
    createdAt ? [name, slug, plan, status, industry, createdAt] : [name, slug, plan, status, industry],
  );
  const businessId = business.rows[0].id;

  const location = await db.query<{ id: string }>(
    `INSERT INTO locations (business_id, name, address, phone)
     VALUES ($1, 'Branch', 'Addr', '02100000000') RETURNING id`,
    [businessId],
  );
  const locationId = location.rows[0].id;

  const identity = await db.query<{ id: string }>(
    `INSERT INTO platform_users (email, password_hash, full_name)
     VALUES ($1, 'hash', $2) RETURNING id`,
    [`${slug}@example.com`, `${name} Owner`],
  );
  await db.query(
    `INSERT INTO users (business_id, platform_user_id, role, full_name, email, is_active)
     VALUES ($1, $2, 'owner', $3, $4, true)`,
    [businessId, identity.rows[0].id, `${name} Owner`, `${slug}@example.com`],
  );

  if (withOrder) {
    await db.query(
      `INSERT INTO orders (location_id, order_number, type, status, total)
       VALUES ($1, 1, 'takeaway', 'completed', 100000)`,
      [locationId],
    );
  }
  return businessId;
}

beforeAll(async () => {
  databaseName = `pos_platform_directory_${randomUUID().replaceAll("-", "")}`;
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
  platformService = await import("../src/lib/platform-service");
  overviewService = await import("../src/lib/platform-overview-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  await seedBusiness({ name: "Alpha Cafe", slug: "alpha", status: "active", plan: "pro", industry: "food_service", createdAt: "2024-01-01", withOrder: true });
  await seedBusiness({ name: "Beta Jewelry", slug: "beta", status: "suspended", plan: "free", industry: "jewelry", createdAt: "2024-06-01" });
  await seedBusiness({ name: "Gamma Shop", slug: "gamma", status: "active", plan: "free", industry: "watch", createdAt: "2024-12-01" });
  await seedBusiness({ name: "Delta Archived", slug: "delta", status: "archived", plan: "pro", industry: "food_service", createdAt: "2023-01-01" });
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

describe("queryBusinesses", () => {
  it("returns all businesses with pagination metadata by default", async () => {
    const result = await platformService.queryBusinesses();
    expect(result.total).toBe(4);
    expect(result.businesses).toHaveLength(4);
    expect(result.page).toBe(1);
  });

  it("filters by status", async () => {
    const active = await platformService.queryBusinesses({ status: "active" });
    expect(active.total).toBe(2);
    expect(active.businesses.every((b) => b.status === "active")).toBe(true);

    const suspended = await platformService.queryBusinesses({ status: "suspended" });
    expect(suspended.total).toBe(1);
    expect(suspended.businesses[0].name).toBe("Beta Jewelry");
  });

  it("filters by plan and industry", async () => {
    const pro = await platformService.queryBusinesses({ plan: "pro" });
    expect(pro.total).toBe(2);

    const jewelry = await platformService.queryBusinesses({ industry: "jewelry" as never });
    expect(jewelry.total).toBe(1);
    expect(jewelry.businesses[0].slug).toBe("beta");
  });

  it("searches over name, slug and subdomain", async () => {
    const byName = await platformService.queryBusinesses({ search: "jewelry" });
    expect(byName.total).toBe(1);
    const bySlug = await platformService.queryBusinesses({ search: "gamma" });
    expect(bySlug.total).toBe(1);
    const none = await platformService.queryBusinesses({ search: "zzzznope" });
    expect(none.total).toBe(0);
  });

  it("filters by activity (has orders vs idle)", async () => {
    const active = await platformService.queryBusinesses({ activity: "active" });
    expect(active.total).toBe(1);
    expect(active.businesses[0].slug).toBe("alpha");

    const idle = await platformService.queryBusinesses({ activity: "idle" });
    expect(idle.total).toBe(3);
  });

  it("filters by created date range", async () => {
    const inRange = await platformService.queryBusinesses({ createdFrom: "2024-01-01", createdTo: "2024-06-30" });
    expect(inRange.total).toBe(2); // alpha + beta
  });

  it("sorts by name and by newest", async () => {
    const byName = await platformService.queryBusinesses({ sort: "name" });
    expect(byName.businesses.map((b) => b.name)).toEqual([
      "Alpha Cafe",
      "Beta Jewelry",
      "Delta Archived",
      "Gamma Shop",
    ]);

    const newest = await platformService.queryBusinesses({ sort: "newest" });
    expect(newest.businesses[0].slug).toBe("gamma"); // 2024-12-01
    const oldest = await platformService.queryBusinesses({ sort: "oldest" });
    expect(oldest.businesses[0].slug).toBe("delta"); // 2023-01-01
  });

  it("paginates and clamps page size", async () => {
    const p1 = await platformService.queryBusinesses({ page: 1, pageSize: 2, sort: "name" });
    expect(p1.businesses).toHaveLength(2);
    expect(p1.total).toBe(4);
    const p2 = await platformService.queryBusinesses({ page: 2, pageSize: 2, sort: "name" });
    expect(p2.businesses).toHaveLength(2);
    expect(p2.businesses[0].name).toBe("Delta Archived");

    // Over-large page size is clamped, never unbounded.
    const clamped = await platformService.queryBusinesses({ pageSize: 100_000 });
    expect(clamped.pageSize).toBeLessThanOrEqual(100);
  });
});

describe("getPlatformOverview", () => {
  it("aggregates business counts and growth in one call", async () => {
    const o = await overviewService.getPlatformOverview(0);
    expect(o.businesses.total).toBe(4);
    expect(o.businesses.active).toBe(2);
    expect(o.businesses.suspended).toBe(1);
    expect(o.businesses.archived).toBe(1);
    expect(o.system.pendingMigrations).toBe(0);
  });

  it("raises a migration alert when migrations are pending", async () => {
    const o = await overviewService.getPlatformOverview(3);
    const alert = o.alerts.find((a) => a.href === "/platform/system");
    expect(alert).toBeDefined();
    expect(alert?.level).toBe("error");
  });

  it("reports empty support/bug/payment counts on a fresh deployment", async () => {
    const o = await overviewService.getPlatformOverview(0);
    expect(o.support.open).toBe(0);
    expect(o.bugReports.new).toBe(0);
    expect(o.payments.manualPending).toBe(0);
  });
});
