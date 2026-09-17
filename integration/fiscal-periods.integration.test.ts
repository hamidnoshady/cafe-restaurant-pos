/**
 * Phase 16 exit criterion: "A locked period rejects every posting path,
 * including the automatic ones" — proven here at the one place all of them
 * funnel through, journal_entries, via migration 0024's trigger. Locked
 * always rejects; soft-closed rejects everyone except the owner or an
 * accountant (the resolved open question on who may post to a
 * closed-but-not-locked period).
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
let fiscalService: typeof import("../src/lib/fiscal-periods-service");

const biz = { id: "" };

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
  databaseName = `pos_fiscal_${randomUUID().replaceAll("-", "")}`;

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
  fiscalService = await import("../src/lib/fiscal-periods-service");

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

const users = { owner: "", accountant: "", cashier: "" };

beforeEach(async () => {
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Ledger Co', $1) RETURNING id",
    [`ledger-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  for (const role of ["owner", "accountant", "cashier"] as const) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, $2, 'Member', 'x') RETURNING id`,
      [biz.id, role],
    );
    users[role] = rows[0].id;
  }
});

async function insertEntry(entryDate: string, createdBy: string | null) {
  return db.query(
    `INSERT INTO journal_entries (business_id, entry_date, memo, source_type, created_by)
     VALUES ($1, $2, 'test', 'manual', $3) RETURNING id`,
    [biz.id, entryDate, createdBy],
  );
}

describe("fiscal year & period creation", () => {
  it("creates a Jalali year's twelve periods, all open", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    expect(year.label).toBe("1404");
    expect(year.startsOn).toBe("2025-03-21");

    const periods = await fiscalService.listPeriods(biz.id, year.id);
    expect(periods).toHaveLength(12);
    expect(periods.every((p) => p.status === "open")).toBe(true);
  });

  it("rejects defining the same fiscal year twice", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    await expect(fiscalService.createFiscalYear(biz.id, 1404)).rejects.toThrow("fiscal_year_exists");
  });

  it("turns simultaneous definitions of one year into one creation and one normal conflict", async () => {
    const results = await Promise.allSettled([
      fiscalService.createFiscalYear(biz.id, 1404),
      fiscalService.createFiscalYear(biz.id, 1404),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toHaveProperty("message", "fiscal_year_exists");

    const [year] = await fiscalService.listFiscalYears(biz.id);
    expect(await fiscalService.listPeriods(biz.id, year.id)).toHaveLength(12);
  });

  it("treats a stale or malformed year id as missing rather than emitting a database cast error", async () => {
    await expect(fiscalService.listPeriods(biz.id, randomUUID())).rejects.toThrow("fiscal_year_not_found");
    await expect(fiscalService.listPeriods(biz.id, "not-a-uuid")).rejects.toThrow("fiscal_year_not_found");
  });

  it("keeps a period inside its parent year and rejects overlapping calendar ranges in the database", async () => {
    const year = await fiscalService.createFiscalYear(biz.id, 1404);

    await expect(
      db.query(
        `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on)
         VALUES ($1, $2, 'outside', '2025-03-19', '2025-03-20')`,
        [biz.id, year.id],
      ),
    ).rejects.toThrow("fiscal_period_outside_year");

    await expect(
      db.query(
        `INSERT INTO fiscal_periods (business_id, fiscal_year_id, label, starts_on, ends_on)
         VALUES ($1, $2, 'overlap', '2025-03-22', '2025-03-23')`,
        [biz.id, year.id],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });
});

describe("an open period", () => {
  it("accepts a posting from anyone", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    await expect(insertEntry("2025-04-15", users.cashier)).resolves.toBeTruthy();
  });
});

describe("a locked period", () => {
  it("rejects every posting, including the owner's and the accountant's", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const periods = await fiscalService.listPeriods(biz.id, year.id);
    const farvardin = periods[0]; // 1404-01, 2025-03-21..2025-04-20

    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", users.owner);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", users.owner);

    await expect(insertEntry("2025-04-01", users.owner)).rejects.toThrow("fiscal_period_locked");
    await expect(insertEntry("2025-04-01", users.accountant)).rejects.toThrow("fiscal_period_locked");
    await expect(insertEntry("2025-04-01", users.cashier)).rejects.toThrow("fiscal_period_locked");
  });

  it("also blocks retiming an existing entry into the locked period", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", users.owner);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", users.owner);

    const entry = await insertEntry("2026-04-01", users.cashier);
    await expect(
      db.query("UPDATE journal_entries SET entry_date = '2025-04-01' WHERE id = $1", [entry.rows[0].id]),
    ).rejects.toThrow("fiscal_period_locked");
  });

  it("does not affect a different, still-open period", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const periods = await fiscalService.listPeriods(biz.id, year.id);

    await fiscalService.setPeriodStatus(biz.id, periods[0].id, "soft_closed", users.owner);
    await fiscalService.setPeriodStatus(biz.id, periods[0].id, "locked", users.owner);

    // Ordibehesht (period[1]) is untouched.
    await expect(insertEntry(periods[1].startsOn, users.cashier)).resolves.toBeTruthy();
  });

  it("reopens back to a postable state", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);

    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", users.owner);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", users.owner);
    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "open", users.owner);

    await expect(insertEntry("2025-04-01", users.cashier)).resolves.toBeTruthy();
  });
});

describe("a soft-closed period", () => {
  it("rejects a cashier's posting but allows the owner's and the accountant's", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);

    await fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", users.owner);

    await expect(insertEntry("2025-04-01", users.cashier)).rejects.toThrow("fiscal_period_soft_closed");
    await expect(insertEntry("2025-04-01", null)).rejects.toThrow("fiscal_period_soft_closed");
    await expect(insertEntry("2025-04-01", users.owner)).resolves.toBeTruthy();
    await expect(insertEntry("2025-04-02", users.accountant)).resolves.toBeTruthy();
  });
});

describe("period status transitions", () => {
  it("serializes competing transitions so a double press cannot both succeed", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);

    const results = await Promise.allSettled([
      fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", users.owner),
      fiscalService.setPeriodStatus(biz.id, farvardin.id, "soft_closed", users.accountant),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") expect(rejected.reason).toHaveProperty("message", "invalid_transition");

    const [updated] = await fiscalService.listPeriods(biz.id, year.id);
    expect(updated.status).toBe("soft_closed");
  });

  it("rejects skipping straight from open to locked", async () => {
    await fiscalService.createFiscalYear(biz.id, 1404);
    const [year] = await fiscalService.listFiscalYears(biz.id);
    const [farvardin] = await fiscalService.listPeriods(biz.id, year.id);

    await expect(
      fiscalService.setPeriodStatus(biz.id, farvardin.id, "locked", users.owner),
    ).rejects.toThrow("invalid_transition");
  });
});
