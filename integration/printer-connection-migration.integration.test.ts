/**
 * Migration 0155 — the printer connection model. Real-database coverage of
 * the legacy → canonical mapping, on the actual upgrade path: a database at
 * the pre-printer state with legacy printer rows, then 0155 applied on top.
 *
 *   system     → {type: 'windows', systemName}   (behaviour fields kept)
 *   network    → {type: 'network', ip, port}
 *   ip-only    → {type: 'network', ...}          (pre-transport rows)
 *   usb/webusb/browser/stub → needsReconnect + legacyTransport, identity kept
 *
 * Nothing is destroyed: a `webusb` row keeps its product name, a `usb` row
 * keeps its device path, so the settings screen can say WHICH printer needs
 * re-pairing.
 */
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let tempDir: string;
let ownerClient: Client;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function createDatabase(): Promise<string> {
  const name = `pos_printer_migration_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${name}"`);
  } finally {
    await maintenance.end();
  }
  return name;
}

/** A migrations directory holding everything up to (but not including) 0155. */
async function preMigrationDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pos-printer-mig-"));
  const all = readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const file of all.filter((name) => name < "0155_printer_connection_model.sql")) {
    await copyFile(join(process.cwd(), "migrations", file), join(dir, file));
  }
  return dir;
}

/** A directory holding only 0155 — the upgrade step under test. */
async function upgradeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pos-printer-upg-"));
  // The runner needs migration 0001 too (it drives the baseline when the
  // schema_migrations table is seeded); reuse the full history minus nothing.
  return dir;
}

beforeAll(async () => {
  databaseName = await createDatabase();
  tempDir = await preMigrationDir();
  await runMigrations({ databaseUrl: urlFor(databaseName), migrationsDir: tempDir, quiet: true });

  ownerClient = new Client({ connectionString: urlFor(databaseName) });
  await ownerClient.connect();

  // A business + location to hang printers off (the FK target).
  const { rows: biz } = await ownerClient.query(
    `INSERT INTO businesses (name, slug, industry) VALUES ('کافه مهاجرت', 'printer-migration-test', 'food_service') RETURNING id`,
  );
  const { rows: loc } = await ownerClient.query(
    `INSERT INTO locations (business_id, name) VALUES ($1, 'شعبهٔ اصلی') RETURNING id`,
    [biz[0].id],
  );
  const locationId = loc[0].id;

  const rows: [string, string, Record<string, unknown>][] = [
    ["رسید سیستم", "receipt", { transport: "system", systemName: "EPSON TM-T20III", ip: null, port: 9100, paper: "thermal80", paperWidthMm: 80, openDrawer: true, isDefault: true }],
    ["آشپزخانه شبکه", "kitchen", { transport: "network", ip: "192.168.1.45", port: 9100, paperWidthMm: 58, paper: "thermal58" }],
    ["قدیمی بدون transport", "receipt", { ip: "192.168.1.50", port: 9101 }],
    ["USB قدیمی", "receipt", { transport: "usb", devicePath: "USB001", paperWidthMm: 80 }],
    ["WebUSB قدیمی", "receipt", { transport: "webusb", usbVendorId: 0x04b8, usbProductId: 0x0e15, usbProductName: "TM-T20III" }],
    ["مرورگر قدیمی", "receipt", { transport: "browser", isDefault: true }],
    ["استاب نصب اولیه", "receipt", { ip: null, port: 9100, driver: "escpos-stub" }],
    ["شبکه بدون پورت", "receipt", { transport: "network", ip: "10.0.0.9" }],
  ];
  for (const [name, kind, connection] of rows) {
    await ownerClient.query(
      `INSERT INTO printers (location_id, name, kind, connection) VALUES ($1, $2, $3, $4)`,
      [locationId, name, kind, JSON.stringify(connection)],
    );
  }
});

afterAll(async () => {
  await ownerClient?.end().catch(() => {});
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function connectionOf(name: string): Promise<Record<string, unknown>> {
  const { rows } = await ownerClient.query(`SELECT connection FROM printers WHERE name = $1`, [name]);
  return rows[0].connection as Record<string, unknown>;
}

describe("migration 0155 — printer connection model", () => {
  it("applies the upgrade step on top of a 0153 database", async () => {
    // Running the FULL history is idempotent — schema_migrations skips every
    // applied file — so exactly one migration (0155) lands here.
    const result = await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
    expect(result.applied).toBe(1);
  });

  it("maps system → windows, keeping the queue name and every behavioural field", async () => {
    const connection = await connectionOf("رسید سیستم");
    expect(connection.type).toBe("windows");
    expect(connection.systemName).toBe("EPSON TM-T20III");
    expect(connection.openDrawer).toBe(true);
    expect(connection.isDefault).toBe(true);
    expect(connection.paper).toBe("thermal80");
    expect(connection.transport).toBeUndefined();
    expect(connection.ip).toBeUndefined();
    expect(connection.driverMode).toBeUndefined();
  });

  it("maps network (and pre-transport ip-only rows) → network, port intact", async () => {
    const network = await connectionOf("آشپزخانه شبکه");
    expect(network.type).toBe("network");
    expect(network.ip).toBe("192.168.1.45");
    expect(network.port).toBe(9100);
    expect(network.paperWidthMm).toBe(58);
    expect(network.systemName).toBeUndefined();

    const legacy = await connectionOf("قدیمی بدون transport");
    expect(legacy.type).toBe("network");
    expect(legacy.ip).toBe("192.168.1.50");
    expect(legacy.port).toBe(9101);

    const noPort = await connectionOf("شبکه بدون پورت");
    expect(noPort.type).toBe("network");
    expect(noPort.ip).toBe("10.0.0.9");
  });

  it("flags usb/webusb/browser/stub rows as needsReconnect with their identity preserved", async () => {
    const usb = await connectionOf("USB قدیمی");
    expect(usb.needsReconnect).toBe(true);
    expect(usb.legacyTransport).toBe("usb");
    expect(usb.devicePath).toBe("USB001");

    const webusb = await connectionOf("WebUSB قدیمی");
    expect(webusb.needsReconnect).toBe(true);
    expect(webusb.legacyTransport).toBe("webusb");
    expect(webusb.usbProductName).toBe("TM-T20III");

    const browser = await connectionOf("مرورگر قدیمی");
    expect(browser.needsReconnect).toBe(true);
    expect(browser.legacyTransport).toBe("browser");
    // Behavioural fields survive so a re-pair can keep them.
    expect(browser.isDefault).toBe(true);

    const stub = await connectionOf("استاب نصب اولیه");
    expect(stub.needsReconnect).toBe(true);
    expect(stub.legacyTransport).toBe("unknown");
    expect(stub.driver).toBeUndefined();
  });

  it("never marks a convertible row as needing reconnection", async () => {
    const { rows } = await ownerClient.query(
      `SELECT name FROM printers WHERE connection @> '{"needsReconnect": true}'::jsonb ORDER BY name`,
    );
    expect(rows.map((r: { name: string }) => r.name).sort()).toEqual(
      ["USB قدیمی", "WebUSB قدیمی", "استاب نصب اولیه", "مرورگر قدیمی"].sort(),
    );
  });
});
