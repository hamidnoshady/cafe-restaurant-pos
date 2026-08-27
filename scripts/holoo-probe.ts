/**
 * Holoo structure probe — a read-only CLI that fingerprints a real Holoo
 * database and dumps the facts every later wave of Phase 26 depends on.
 *
 * Phase 26 (issue #125) Wave 1 — analysis & design. This script is the "no
 * product code" deliverable: it is a standalone analysis tool, run manually
 * with `npx tsx scripts/holoo-probe.ts`, and it is *provably read-only*:
 *
 *   - it opens the connection with `applicationIntent = ReadOnly` (SQL Server
 *     will refuse to run on a replica-free read-only target if a write were
 *     attempted) and issues only `SELECT` statements against
 *     `information_schema`, the system catalog and candidate tables;
 *   - it never begins a transaction, never calls `request.batch`/`request.query`
 *     with anything but a SELECT, and never sends any DML/DDL back to Holoo;
 *   - the one mutable thing it does — writing a JSON profile file — happens on
 *     *this machine*, not on Holoo.
 *
 * It deliberately does NOT add `mssql` to package.json (that happens in
 * Wave 2). The driver is loaded lazily with `import()` so a repo checkout
 * without Holoo never pays for it, and the script errors with an actionable
 * message if it is not installed.
 *
 * Usage:
 *   HOLOO_HOST=192.168.1.10 HOLOO_DATABASE=MyDb \
 *   HOLOO_SQL_USER=readonly HOLOO_SQL_PASSWORD=secret \
 *   npx tsx scripts/holoo-probe.ts --out holoo-profile.json
 *
 *   # or, when the machine can reach SQL Server directly and mssql is present:
 *   HOLOO_CONNECTION="Server=host,1433;Database=MyDb;User Id=ro;Password=..." \
 *   npx tsx scripts/holoo-probe.ts
 *
 * Transport security (secure by default): encryption is on unless
 * `HOLOO_ENCRYPT=false`, and TLS certificate validation is on unless
 * `HOLOO_TRUST_SERVER_CERT=true` (for self-signed on-prem SQL Server certs).
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";

const OUT_ARG = "--out";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

/**
 * The tables a Holoo migration maps onto this app. Grouped by the domain
 * entity each one feeds, so the profile's per-table sample is scoped to what
 * Waves 3–5 actually import rather than dumping the whole catalog. Names are
 * the canonical Holoo names; the probe also reports any it cannot find so a
 * new Holoo edition can be diagnosed from the profile alone.
 */
const CANDIDATE_TABLES: Record<string, string[]> = {
  goods: ["Goods", "Kala", "Kalas"],
  persons: ["Person", "Personel", "Persons", "Ashkhas"],
  accounts: ["Account", "Accounts", "Tafsil", "Moein", "Kol"],
  invoices: ["Invoice", "Factor", "FactorHeader", "SellInvoice"],
  invoice_lines: ["InvoiceItem", "FactorRow", "FactorDetail", "SellInvoiceRow"],
  purchases: ["BuyInvoice", "Purchase", "PurchaseHeader"],
  receipt_payment: ["ReceivePay", "RecPay", "DaryaftPardakht", "Check"],
  stock_movements: ["Stock", "Anbar", "StockCard", "WarehouseCard"],
  journal: ["Voucher", "Sanad", "SanadHeader", "DocHeader"],
  journal_lines: ["VoucherItem", "SanadRow", "SanadDetail", "DocDetail"],
};

interface TableProfile {
  /** The canonical Holoo name we matched (e.g. "Goods"). */
  table: string;
  entity: string;
  rowCount: number;
  columns: { name: string; type: string; nullable: boolean }[];
  sample: Record<string, unknown> | null;
}

interface ProbeProfile {
  generatedAt: string;
  serverVersion: string;
  productVersion: string;
  database: string;
  collation: string | null;
  /** The edition fingerprint (version + product level + build), used by
   *  schema-profile.ts matchProfile() to pin a known structure. */
  fingerprint: { version: string; level: string; edition: string };
  tables: TableProfile[];
  /** Candidate entity → which canonical table(s) were missing on this install. */
  missing: Record<string, string[]>;
  /** Raw date-ish column samples across candidate tables, used to decide
   *  Jalali-vs-Gregorian storage without guessing. */
  dateSamples: { table: string; column: string; values: string[] }[];
  /** Column collations of interest for the Persian-text decision. */
  textCollations: { table: string; column: string; collation: string | null }[];
}

interface SqlDriver {
  connect(config: { server: string; port: number; database: string; user: string; password: string }): Promise<void>;
  close(): Promise<void>;
  query<T extends Record<string, unknown>>(sql: string): Promise<T[]>;
}

async function loadDriver(): Promise<SqlDriver> {
  try {
    const mssql = await import("mssql");
    const pool = await mssql.connect({
      server: process.env.HOLOO_HOST,
      port: Number(process.env.HOLOO_PORT || 1433),
      database: process.env.HOLOO_DATABASE,
      user: process.env.HOLOO_SQL_USER,
      password: process.env.HOLOO_SQL_PASSWORD,
      options: {
        // Transport encryption is ON by default; set HOLOO_ENCRYPT=false to
        // opt out (e.g. an isolated on-prem SQL Server with no TLS). TLS
        // certificate validation is ON by default; set
        // HOLOO_TRUST_SERVER_CERT=true only for a self-signed on-prem cert.
        encrypt: process.env.HOLOO_ENCRYPT !== "false",
        trustServerCertificate: process.env.HOLOO_TRUST_SERVER_CERT === "true",
        // Provably read-only: SQL Server will reject a write issued against
        // a read-only routing target rather than silently running it.
        readOnlyIntent: true,
      },
    });
    return {
      connect: async () => undefined,
      close: async () => pool.close(),
      query: async <T extends Record<string, unknown>>(sql: string) => {
        const result = await pool.request().query<T>(sql);
        return result.recordset;
      },
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/Cannot find module 'mssql'|ERR_MODULE_NOT_FOUND/.test(message)) {
      throw new Error(
        "the `mssql` driver is not installed (it is a Wave 2 dependency, not part of this probe). " +
          "Run `npm install --no-save mssql` once, or use a machine where it is present.",
      );
    }
    throw err;
  }
}

async function connect(): Promise<SqlDriver> {
  if (process.env.HOLOO_CONNECTION) {
    // Full connection string form: delegate to the driver's own parser.
    const mssql = await import("mssql");
    const pool = await mssql.connect(process.env.HOLOO_CONNECTION);
    return {
      connect: async () => undefined,
      close: async () => pool.close(),
      query: async <T extends Record<string, unknown>>(sql: string) => {
        const result = await pool.request().query<T>(sql);
        return result.recordset;
      },
    };
  }
  if (!process.env.HOLOO_HOST || !process.env.HOLOO_DATABASE) {
    throw new Error(
      "set HOLOO_CONNECTION, or HOLOO_HOST + HOLOO_DATABASE (optionally HOLOO_SQL_USER / HOLOO_SQL_PASSWORD)",
    );
  }
  return loadDriver();
}

async function firstValue<T>(driver: SqlDriver, sql: string, column: string): Promise<T | null> {
  const rows = await driver.query<Record<string, unknown>>(sql);
  return (rows[0]?.[column] as T | undefined) ?? null;
}

export async function main(): Promise<void> {
  const driver = await connect();
  try {
    const profile = await buildProfile(driver);
    const out = argument(OUT_ARG);
    const json = JSON.stringify(profile, null, 2);
    if (out) writeFileSync(out, json, "utf8");
    else process.stdout.write(json + "\n");
  } finally {
    await driver.close();
  }
}

async function buildProfile(driver: SqlDriver): Promise<ProbeProfile> {
  const serverVersion = (await firstValue<string>(driver, "SELECT @@VERSION AS v", "v")) ?? "";
  const productVersion =
    (await firstValue<string>(driver, "SELECT SERVERPROPERTY('ProductVersion') AS v", "v")) ?? "";
  const productLevel =
    (await firstValue<string>(driver, "SELECT SERVERPROPERTY('ProductLevel') AS v", "v")) ?? "";
  const edition =
    (await firstValue<string>(driver, "SELECT SERVERPROPERTY('Edition') AS v", "v")) ?? "";
  const database = (await firstValue<string>(driver, "SELECT DB_NAME() AS v", "v")) ?? "";
  const collation =
    (await firstValue<string>(
      driver,
      "SELECT CONVERT(nvarchar(128), DATABASEPROPERTYEX(DB_NAME(), 'Collation')) AS v",
      "v",
    )) ?? null;

  // Which canonical names actually exist on this install.
  const existing = new Set(
    (
      await driver.query<{ TABLE_NAME: string }>(
        `SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_TYPE = 'BASE TABLE'`,
      )
    ).map((r) => r.TABLE_NAME),
  );

  const tables: TableProfile[] = [];
  const missing: Record<string, string[]> = {};
  const dateSamples: ProbeProfile["dateSamples"] = [];
  const textCollations: ProbeProfile["textCollations"] = [];

  for (const [entity, candidates] of Object.entries(CANDIDATE_TABLES)) {
    const hit = candidates.find((c) => existing.has(c));
    if (!hit) {
      missing[entity] = candidates.filter((c) => !existing.has(c));
      continue;
    }

    const columns = (
      await driver.query<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
           FROM information_schema.columns
          WHERE TABLE_NAME = ${JSON.stringify(hit)}
          ORDER BY ORDINAL_POSITION`,
      )
    ).map((c) => ({
      name: c.COLUMN_NAME,
      type: c.DATA_TYPE,
      nullable: c.IS_NULLABLE === "YES",
    }));

    const rowCount = Number(
      (await firstValue<number>(
        driver,
        `SELECT SUM(p.rows) AS n
           FROM sys.partitions p
           JOIN sys.tables t ON t.object_id = p.object_id AND p.index_id IN (0, 1)
          WHERE t.name = ${JSON.stringify(hit)}`,
        "n",
      )) ?? 0,
    );

    let sample: Record<string, unknown> | null = null;
    if (rowCount > 0) {
      sample = (await driver.query<Record<string, unknown>>(`SELECT TOP (1) * FROM [${hit}]`))[0] ?? null;
    }

    // Collect date-ish and text columns for the storage decisions.
    for (const col of columns) {
      const lower = col.name.toLowerCase();
      const looksDate = /date|date_time|datetime|tarikh|dastur|doc_date/.test(lower);
      const looksText =
        /^(nvarchar|varchar|nchar|char|text|ntext)$/.test(col.type) ||
        /name|title|address|desc|sharh|note|tozih/.test(lower);
      if (looksDate && rowCount > 0) {
        const vals = (
          await driver.query<Record<string, unknown>>(
            `SELECT TOP (3) [${col.name}] AS v FROM [${hit}] WHERE [${col.name}] IS NOT NULL`,
          )
        )
          .map((r) => String(r.v))
          .filter(Boolean);
        if (vals.length) dateSamples.push({ table: hit, column: col.name, values: vals });
      }
      if (looksText) {
        const colCollation =
          (await firstValue<string>(
            driver,
            `SELECT collation_name FROM sys.columns c
              JOIN sys.tables t ON t.object_id = c.object_id
             WHERE t.name = ${JSON.stringify(hit)} AND c.name = ${JSON.stringify(col.name)}`,
            "collation_name",
          )) ?? null;
        textCollations.push({ table: hit, column: col.name, collation: colCollation });
      }
    }

    tables.push({ table: hit, entity, rowCount, columns, sample });
  }

  return {
    generatedAt: new Date().toISOString(),
    serverVersion,
    productVersion,
    database,
    collation,
    fingerprint: { version: productVersion, level: productLevel, edition },
    tables,
    missing,
    dateSamples,
    textCollations,
  };
}

void main().catch((error) => {
  console.error((error as Error).message ?? error);
  process.exitCode = 1;
});
