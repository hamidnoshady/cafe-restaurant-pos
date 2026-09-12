/**
 * Warehouse counting — visual profiles and count-scan evidence (migration
 * 0147).
 *
 * What can only be proven here, against a real database:
 *
 *   - the CHECK constraints the API leans on (data-URL ceiling, method enum,
 *     confidence band, non-negative quantity) actually reject bad rows — the
 *     API validates first, but the constraint is what a buggy client or a
 *     future route cannot talk its way past;
 *   - deleting an item takes its profiles and evidence with it (ON DELETE
 *     CASCADE), so an archived SKU cannot leave orphaned image rows behind;
 *   - the branch-scoped join the routes use (profiles/scans of items at THIS
 *     location only) really narrows to the branch — the tenancy boundary the
 *     RLS policies in `tenant-isolation.integration.test.ts` already prove
 *     generically for both tables.
 *
 * The pure payload validators have their own unit tests
 * (`src/lib/inventory-visual-profiles.test.ts`) and the counting engine is
 * covered by `src/lib/vision/count.test.ts` — nothing here re-tests those.
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

const JPEG = "data:image/jpeg;base64," + "A".repeat(400);

interface Seeded {
  businessId: string;
  locationA: string;
  locationB: string;
  itemIdA: string;
  itemIdB: string;
}

async function seed(): Promise<Seeded> {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    ["کافهٔ آزمون", `vision-${randomUUID().slice(0, 8)}`],
  );
  const businessId = business.rows[0].id;

  const locationA = (
    await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'انبار مرکزی') RETURNING id",
      [businessId],
    )
  ).rows[0].id;
  const locationB = (
    await db.query<{ id: string }>(
      "INSERT INTO locations (business_id, name) VALUES ($1, 'میز پذیرش') RETURNING id",
      [businessId],
    )
  ).rows[0].id;

  const itemIdA = (
    await db.query<{ id: string }>(
      "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'لیوان کاغذی ۳۶۰', 'عدد') RETURNING id",
      [locationA],
    )
  ).rows[0].id;
  const itemIdB = (
    await db.query<{ id: string }>(
      "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'شیر یک‌لیتری', 'عدد') RETURNING id",
      [locationB],
    )
  ).rows[0].id;

  return { businessId, locationA, locationB, itemIdA, itemIdB };
}

async function insertProfile(itemId: string, businessId: string, extra: Record<string, unknown> = {}) {
  const row = {
    business_id: businessId,
    inventory_item_id: itemId,
    source: "manual",
    kind: "color",
    image_data_url: JPEG,
    region: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }),
    features: JSON.stringify({
      kind: "color",
      color: { signature: { mean: [50, 10, -5], spread: [2, 1, 1] }, tolerance: 12 },
      unitAreaRatio: 0.02,
    }),
    ...extra,
  };
  return db.query(
    `INSERT INTO inventory_item_visual_profiles
        (business_id, inventory_item_id, source, kind, image_data_url, region, features)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      row.business_id,
      row.inventory_item_id,
      row.source,
      row.kind,
      row.image_data_url,
      row.region,
      row.features,
    ],
  );
}

beforeAll(async () => {
  databaseName = `pos_invvisual_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

describe("visual stock count storage", () => {
  it("stores a manual color profile and reads it back with its features", async () => {
    const s = await seed();
    const { rows } = await insertProfile(s.itemIdA, s.businessId);
    expect(rows).toHaveLength(1);

    const read = await db.query<{ source: string; kind: string; features: { kind: string } }>(
      "SELECT source, kind, features FROM inventory_item_visual_profiles WHERE id = $1",
      [rows[0].id],
    );
    expect(read.rows[0].source).toBe("manual");
    expect(read.rows[0].kind).toBe("color");
    expect(read.rows[0].features.kind).toBe("color");
  });

  it("rejects rows the API's ceilings exist to prevent", async () => {
    const s = await seed();
    await expect(insertProfile(s.itemIdA, s.businessId, { image_data_url: "data:image/jpeg;base64," + "A".repeat(220_001) }))
      .rejects.toThrow();
    await expect(insertProfile(s.itemIdA, s.businessId, { source: "robot" })).rejects.toThrow();
    await expect(insertProfile(s.itemIdA, s.businessId, { kind: "blob" })).rejects.toThrow();

    await expect(
      db.query(
        `INSERT INTO inventory_count_scans
            (business_id, location_id, inventory_item_id, method, counted_qty, confidence, boxes, image_data_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.businessId, s.locationA, s.itemIdA, "cv_magic", "3", "0.8", "[]", JPEG],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO inventory_count_scans
            (business_id, location_id, inventory_item_id, method, counted_qty, confidence, boxes, image_data_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.businessId, s.locationA, s.itemIdA, "cv_color", "-1", "0.8", "[]", JPEG],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO inventory_count_scans
            (business_id, location_id, inventory_item_id, method, counted_qty, confidence, boxes, image_data_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.businessId, s.locationA, s.itemIdA, "cv_color", "3", "1.5", "[]", JPEG],
      ),
    ).rejects.toThrow();
  });

  it("accepts all three count methods on the evidence table", async () => {
    const s = await seed();
    for (const method of ["cv_color", "cv_round", "ai_vision"]) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO inventory_count_scans
            (business_id, location_id, inventory_item_id, method, counted_qty, confidence, boxes, image_data_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [s.businessId, s.locationA, s.itemIdA, method, "3", "0.8", "[]", JPEG],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it("the branch-scoped profile join only sees the active branch's items", async () => {
    const s = await seed();
    await insertProfile(s.itemIdA, s.businessId); // انبار مرکزی
    await insertProfile(s.itemIdB, s.businessId); // میز پذیرش

    // The exact join shape GET /api/inventory/visual-profiles uses.
    const central = await db.query<{ id: string }>(
      `SELECT p.id FROM inventory_item_visual_profiles p
         JOIN inventory_items i ON i.id = p.inventory_item_id
        WHERE p.inventory_item_id = $1 AND i.location_id = $2`,
      [s.itemIdA, s.locationA],
    );
    const reception = await db.query<{ id: string }>(
      `SELECT p.id FROM inventory_item_visual_profiles p
         JOIN inventory_items i ON i.id = p.inventory_item_id
        WHERE p.inventory_item_id = $1 AND i.location_id = $2`,
      [s.itemIdA, s.locationB],
    );
    expect(central.rows).toHaveLength(1);
    expect(reception.rows).toHaveLength(0);
  });

  it("deleting an item cascades to its profiles and evidence", async () => {
    const s = await seed();
    const profile = await insertProfile(s.itemIdA, s.businessId);
    const scan = await db.query<{ id: string }>(
      `INSERT INTO inventory_count_scans
          (business_id, location_id, inventory_item_id, method, counted_qty, confidence, boxes, image_data_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [s.businessId, s.locationA, s.itemIdA, "cv_round", "7", "0.9", "[]", JPEG],
    );

    await db.query("DELETE FROM inventory_items WHERE id = $1", [s.itemIdA]);

    const profilesLeft = await db.query("SELECT 1 FROM inventory_item_visual_profiles WHERE id = $1", [
      profile.rows[0].id,
    ]);
    const scansLeft = await db.query("SELECT 1 FROM inventory_count_scans WHERE id = $1", [
      scan.rows[0].id,
    ]);
    expect(profilesLeft.rowCount).toBe(0);
    expect(scansLeft.rowCount).toBe(0);
  });
});
