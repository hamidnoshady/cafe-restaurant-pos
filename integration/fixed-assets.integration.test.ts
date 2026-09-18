/**
 * Phase 22 Wave 5, second slice (issue #160 §2): fixed-asset register &
 * straight-line depreciation. Proves accumulatedDepreciation/bookValue are
 * correctly reconstructed from posted fixed_asset_depreciation_entries
 * (never a shadow column), depreciation posts a balanced entry against the
 * right accounts, the same period can't be depreciated twice, an asset
 * can't be depreciated past its salvage value, and deletion is blocked once
 * anything has been posted.
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
let fixedAssetsService: typeof import("../src/lib/fixed-assets-service");
let fiscalService: typeof import("../src/lib/fiscal-periods-service");
let provisioning: typeof import("../src/lib/business-provisioning");

const biz = { id: "", locationId: "" };
const acct = { depreciationExpense: "", accumulatedDepreciation: "" };
const owner = { id: "" };

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
  databaseName = `pos_fixed_assets_${randomUUID().replaceAll("-", "")}`;

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
  fixedAssetsService = await import("../src/lib/fixed-assets-service");
  fiscalService = await import("../src/lib/fiscal-periods-service");
  provisioning = await import("../src/lib/business-provisioning");

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

beforeEach(async () => {
  await db.query("DELETE FROM fixed_asset_depreciation_entries");
  await db.query("DELETE FROM fixed_assets");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Fixed Assets Co', $1) RETURNING id",
    [`fa-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const ownerRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  owner.id = ownerRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '5700', 'Depreciation expense', 'expense'), ($1, '1510', 'Accumulated depreciation', 'asset')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "5700") acct.depreciationExpense = r.id;
    if (r.code === "1510") acct.accumulatedDepreciation = r.id;
  }
});

async function createAsset(overrides: Partial<{ cost: number; salvageValue: number; usefulLifeMonths: number }> = {}) {
  return fixedAssetsService.createFixedAsset({
    businessId: biz.id,
    locationId: biz.locationId,
    name: "یخچال صنعتی",
    acquisitionDate: "2025-01-01",
    cost: overrides.cost ?? 120_000_000,
    salvageValue: overrides.salvageValue ?? 0,
    usefulLifeMonths: overrides.usefulLifeMonths ?? 60,
    createdBy: owner.id,
  });
}

describe("createFixedAsset", () => {
  it("registers an asset with zero accumulated depreciation and a book value equal to cost", async () => {
    const asset = await createAsset();
    expect(asset.accumulatedDepreciation).toBe(0);
    expect(asset.bookValue).toBe(120_000_000);
  });

  it("rejects an invalid asset (e.g. salvage value not less than cost)", async () => {
    await expect(createAsset({ salvageValue: 120_000_000 })).rejects.toThrow();
  });
});

describe("postDepreciation", () => {
  it("posts a balanced entry (Debit depreciation expense / Credit accumulated depreciation) for the monthly amount", async () => {
    const asset = await createAsset(); // 120,000,000 / 60 = 2,000,000/month
    const { amount } = await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "1404-01",
      entryDate: "2025-02-01",
      createdBy: owner.id,
    });
    expect(amount).toBe(2_000_000);

    const { rows: entries } = await db.query<{ id: string; memo: string; source_type: string }>(
      `SELECT id, memo, source_type FROM journal_entries WHERE business_id = $1`,
      [biz.id],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].source_type).toBe("fixed_asset_depreciation");

    const { rows: lines } = await db.query<{ account_id: string; debit: string; credit: string }>(
      `SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC`,
      [entries[0].id],
    );
    expect(lines).toEqual([
      { account_id: acct.depreciationExpense, debit: "2000000", credit: "0" },
      { account_id: acct.accumulatedDepreciation, debit: "0", credit: "2000000" },
    ]);
  });

  it("updates listFixedAssets' reconstructed accumulatedDepreciation and bookValue", async () => {
    const asset = await createAsset();
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "p1",
      createdBy: owner.id,
    });
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "p2",
      createdBy: owner.id,
    });

    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(4_000_000);
    expect(listed.bookValue).toBe(116_000_000);
  });

  it("refuses to post the same period twice for the same asset", async () => {
    const asset = await createAsset();
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "1404-01",
      createdBy: owner.id,
    });
    await expect(
      fixedAssetsService.postDepreciation({
        businessId: biz.id,
        locationId: biz.locationId,
        fixedAssetId: asset.id,
        periodLabel: "1404-01",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("period_already_depreciated");

    // The rejected attempt didn't leave a second journal entry behind.
    const { rows } = await db.query<{ count: string }>(`SELECT count(*)::text FROM journal_entries WHERE business_id = $1`, [
      biz.id,
    ]);
    expect(rows[0].count).toBe("1");
  });

  it("caps the final period at what's left of the depreciable base, then refuses further depreciation", async () => {
    // cost 100,000, salvage 0, useful life 3 months -> monthly = 33,333.33... rounds to 33,333.
    const asset = await createAsset({ cost: 100_000, salvageValue: 0, usefulLifeMonths: 3 });

    const p1 = await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "p1",
      createdBy: owner.id,
    });
    const p2 = await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "p2",
      createdBy: owner.id,
    });
    const p3 = await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "p3",
      createdBy: owner.id,
    });

    expect(p1.amount + p2.amount + p3.amount).toBe(100_000);
    const [listed] = await fixedAssetsService.listFixedAssets(biz.id);
    expect(listed.accumulatedDepreciation).toBe(100_000);
    expect(listed.bookValue).toBe(0);

    await expect(
      fixedAssetsService.postDepreciation({
        businessId: biz.id,
        locationId: biz.locationId,
        fixedAssetId: asset.id,
        periodLabel: "p4",
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fully_depreciated");
  });

  it("refuses to post into a locked fiscal period", async () => {
    const asset = await createAsset();
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", owner.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", owner.id);

    await expect(
      fixedAssetsService.postDepreciation({
        businessId: biz.id,
        locationId: biz.locationId,
        fixedAssetId: asset.id,
        periodLabel: "p1",
        entryDate: farvardin.startsOn,
        createdBy: owner.id,
      }),
    ).rejects.toThrow("fiscal_period_locked");
  });
});

describe("deleteFixedAsset", () => {
  it("deletes an asset with no depreciation posted", async () => {
    const asset = await createAsset();
    await fixedAssetsService.deleteFixedAsset(biz.id, asset.id);
    expect(await fixedAssetsService.listFixedAssets(biz.id)).toEqual([]);
  });

  it("throws 404 for nonexistent asset", async () => {
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, randomUUID())).rejects.toThrow("fixed_asset_not_found");
  });

  it("refuses to delete an asset that has depreciation posted", async () => {
    const asset = await createAsset();
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "p1",
      createdBy: owner.id,
    });
    await expect(fixedAssetsService.deleteFixedAsset(biz.id, asset.id)).rejects.toThrow("fixed_asset_has_depreciation");
  });
});

describe("getFixedAssetWithDepreciation", () => {
  it("retrieves the asset along with its full depreciation history", async () => {
    const asset = await createAsset();
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "1404-01",
      entryDate: "2025-04-01",
      createdBy: owner.id,
    });
    await fixedAssetsService.postDepreciation({
      businessId: biz.id,
      locationId: biz.locationId,
      fixedAssetId: asset.id,
      periodLabel: "1404-02",
      entryDate: "2025-05-01",
      createdBy: owner.id,
    });

    const result = await fixedAssetsService.getFixedAssetWithDepreciation(biz.id, asset.id);
    expect(result.fixedAsset.id).toBe(asset.id);
    expect(result.fixedAsset.accumulatedDepreciation).toBe(4_000_000);
    expect(result.fixedAsset.depreciationCount).toBe(2);
    expect(result.fixedAsset.locationName).toBe("Main");
    expect(result.depreciationEntries).toHaveLength(2);
    expect(result.depreciationEntries[0].periodLabel).toBe("1404-02");
    expect(result.depreciationEntries[0].amount).toBe(2_000_000);
    expect(result.depreciationEntries[0].journalEntryId).toBeTruthy();
    expect(result.depreciationEntries[0].createdByName).toBe("Owner");
  });
});

/**
 * Depreciation is offered to every trade (`ledger` is a CORE_MODULE), but only
 * F&B's seeded chart had either side of the entry: the four retail templates
 * carried «اثاثه و تجهیزات» with no 1510 under it and no 5700 to debit, so a
 * jewellery or cosmetics shop got `ledger_account_missing` the first time it ran
 * a month's depreciation.
 *
 * Seeded from the real template on purpose — hand-inserting the two accounts,
 * as the fixture above does, is exactly what let the gap go unnoticed.
 */
describe("depreciation for a business that is not a café", () => {
  it.each(["jewelry", "watch", "accessories", "cosmetics"] as const)(
    "posts against the %s template's own chart",
    async (industry) => {
      const bizRow = await db.query<{ id: string }>(
        "INSERT INTO businesses (name, slug, industry) VALUES ($1, $2, $3) RETURNING id",
        [`${industry} Co`, `${industry}-${randomUUID().slice(0, 8)}`, industry],
      );
      const businessId = bizRow.rows[0].id;
      const locRow = await db.query<{ id: string }>(
        `INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`,
        [businessId],
      );

      const client = await dbLib.getPool().connect();
      try {
        await provisioning.seedChartOfAccounts(client, businessId, industry);
      } finally {
        client.release();
      }

      const asset = await fixedAssetsService.createFixedAsset({
        businessId,
        locationId: locRow.rows[0].id,
        name: "ویترین",
        acquisitionDate: "2025-01-01",
        cost: 120_000_000,
        salvageValue: 0,
        usefulLifeMonths: 60,
        createdBy: null,
      });

      await fixedAssetsService.postDepreciation({
        businessId,
        locationId: locRow.rows[0].id,
        fixedAssetId: asset.id,
        periodLabel: "بهمن ۱۴۰۳",
        createdBy: null,
      });

      const { rows } = await db.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, jl.debit::text AS debit, jl.credit::text AS credit
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN accounts a ON a.id = jl.account_id
          WHERE je.business_id = $1
          ORDER BY a.code`,
        [businessId],
      );
      expect(rows.map((r) => r.code)).toEqual(["1510", "5700"]);
      expect(Number(rows.find((r) => r.code === "5700")!.debit)).toBe(2_000_000);
      expect(Number(rows.find((r) => r.code === "1510")!.credit)).toBe(2_000_000);
      expect(asset.cost).toBe(120_000_000);
    },
  );
});
