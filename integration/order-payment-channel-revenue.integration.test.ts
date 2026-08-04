/**
 * Phase 22 Wave 4 (issue #160 §4): order payment now credits a
 * channel-specific revenue account (dine-in/takeaway/delivery) instead of
 * one flat "sales revenue" account, keyed off orders.type. Proves
 * postExactOrderPaymentEntry — the live posting path called from
 * /api/orders/[id]/pay — picks the right account per channel and still
 * posts a balanced entry.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import type { RialText } from "../src/lib/inventory-exact";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let ledgerService: typeof import("../src/lib/ledger-service");

const biz = { id: "", locationId: "" };
const acct = {
  cash: "",
  bankClearing: "",
  accountsReceivable: "",
  dineIn: "",
  takeaway: "",
  delivery: "",
  vatPayable: "",
  tipsPayable: "",
};

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
  databaseName = `pos_channel_rev_${randomUUID().replaceAll("-", "")}`;

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
  ledgerService = await import("../src/lib/ledger-service");

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
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM inventory_events");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Channel Rev Co', $1) RETURNING id",
    [`chrev-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const locRow = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [biz.id],
  );
  biz.locationId = locRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '1120', 'Card clearing', 'asset'),
            ($1, '1200', 'Accounts Receivable', 'asset'),
            ($1, '4310', 'Dine-in', 'revenue'),
            ($1, '4320', 'Takeaway', 'revenue'), ($1, '4330', 'Delivery', 'revenue'),
            ($1, '2200', 'VAT Payable', 'liability'), ($1, '2400', 'Tips Payable', 'liability')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "1120") acct.bankClearing = r.id;
    if (r.code === "1200") acct.accountsReceivable = r.id;
    if (r.code === "4310") acct.dineIn = r.id;
    if (r.code === "4320") acct.takeaway = r.id;
    if (r.code === "4330") acct.delivery = r.id;
    if (r.code === "2200") acct.vatPayable = r.id;
    if (r.code === "2400") acct.tipsPayable = r.id;
  }
});

async function newInventoryEventId(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO inventory_events (business_id, location_id, event_type, source_type, source_id)
     VALUES ($1, $2, 'sale_consumption', 'order', $3) RETURNING id`,
    [biz.id, biz.locationId, randomUUID()],
  );
  return rows[0].id;
}

describe("postExactOrderPaymentEntry — channel revenue split", () => {
  it.each([
    ["dine_in", "dineIn"],
    ["takeaway", "takeaway"],
    ["delivery", "delivery"],
  ] as const)("credits the %s channel's own revenue account", async (channel, acctKey) => {
    const inventoryEventId = await newInventoryEventId();
    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      entryId = await ledgerService.postExactOrderPaymentEntry(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        orderId: randomUUID(),
        createdBy: null,
        method: "cash",
        amount: "110000" as RialText,
        tax: "10000" as RialText,
        inventoryEventId,
        orderChannel: channel,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect(entryId).not.toBeNull();
    const lines = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entryId],
    );
    expect(lines.rows).toEqual([
      { account_id: acct.cash, debit: "110000", credit: "0" },
      { account_id: acct[acctKey], debit: "0", credit: "100000" },
      { account_id: acct.vatPayable, debit: "0", credit: "10000" },
    ]);
  });

  it("posts a balanced entry regardless of channel", async () => {
    const inventoryEventId = await newInventoryEventId();
    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      entryId = await ledgerService.postExactOrderPaymentEntry(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        orderId: randomUUID(),
        createdBy: null,
        method: "cash",
        amount: "55000" as RialText,
        tax: "5000" as RialText,
        inventoryEventId,
        orderChannel: "delivery",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const totals = await db.query<{ debit_sum: string; credit_sum: string }>(
      "SELECT sum(debit)::text AS debit_sum, sum(credit)::text AS credit_sum FROM journal_lines WHERE entry_id = $1",
      [entryId],
    );
    expect(totals.rows[0].debit_sum).toBe(totals.rows[0].credit_sum);
  });

  it("fails with a missing-account error if the business's chart is missing the channel's revenue account", async () => {
    await db.query("DELETE FROM accounts WHERE business_id = $1 AND code = '4330'", [biz.id]);
    const inventoryEventId = await newInventoryEventId();
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await expect(
        ledgerService.postExactOrderPaymentEntry(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          orderId: randomUUID(),
          createdBy: null,
          method: "cash",
          amount: "10000" as RialText,
          tax: "0" as RialText,
          inventoryEventId,
          orderChannel: "delivery",
        }),
      ).rejects.toThrow(ledgerService.MissingLedgerAccountError);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});

describe("postExactOrderPaymentEntry — tip capture (issue #160 §4)", () => {
  it("with no tip, behaves exactly as before: no tipsPayable line, debit = bill only", async () => {
    const inventoryEventId = await newInventoryEventId();
    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      entryId = await ledgerService.postExactOrderPaymentEntry(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        orderId: randomUUID(),
        createdBy: null,
        method: "cash",
        amount: "110000" as RialText,
        tax: "10000" as RialText,
        inventoryEventId,
        orderChannel: "dine_in",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const lines = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY debit DESC",
      [entryId],
    );
    expect(lines.rows).toEqual([
      { account_id: acct.cash, debit: "110000", credit: "0" },
      { account_id: acct.dineIn, debit: "0", credit: "100000" },
      { account_id: acct.vatPayable, debit: "0", credit: "10000" },
    ]);
  });

  it("with a tip, debits the bill plus the tip, and credits tipsPayable — not revenue — for the tip", async () => {
    const inventoryEventId = await newInventoryEventId();
    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      entryId = await ledgerService.postExactOrderPaymentEntry(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        orderId: randomUUID(),
        createdBy: null,
        method: "cash",
        amount: "110000" as RialText,
        tax: "10000" as RialText,
        inventoryEventId,
        orderChannel: "dine_in",
        tip: "20000" as RialText,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    // Ordered by id (insertion order), not debit DESC: with three
    // credit-only lines, "debit DESC" has no deterministic tiebreaker.
    const lines = await db.query<{ account_id: string; debit: string; credit: string }>(
      "SELECT account_id, debit, credit FROM journal_lines WHERE entry_id = $1 ORDER BY id",
      [entryId],
    );
    // Debit = bill (110,000) + tip (20,000) = 130,000 — the real cash movement.
    expect(lines.rows).toEqual([
      { account_id: acct.cash, debit: "130000", credit: "0" },
      { account_id: acct.dineIn, debit: "0", credit: "100000" },
      { account_id: acct.vatPayable, debit: "0", credit: "10000" },
      { account_id: acct.tipsPayable, debit: "0", credit: "20000" },
    ]);
  });

  it("posts a balanced entry when a tip is included", async () => {
    const inventoryEventId = await newInventoryEventId();
    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      entryId = await ledgerService.postExactOrderPaymentEntry(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        orderId: randomUUID(),
        createdBy: null,
        method: "card",
        amount: "75000" as RialText,
        tax: "0" as RialText,
        inventoryEventId,
        orderChannel: "takeaway",
        tip: "15000" as RialText,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const totals = await db.query<{ debit_sum: string; credit_sum: string }>(
      "SELECT sum(debit)::text AS debit_sum, sum(credit)::text AS credit_sum FROM journal_lines WHERE entry_id = $1",
      [entryId],
    );
    expect(totals.rows[0].debit_sum).toBe(totals.rows[0].credit_sum);
    expect(totals.rows[0].debit_sum).toBe("90000");
  });

  it("a business missing tipsPayable can still complete a zero-tip payment", async () => {
    await db.query("DELETE FROM accounts WHERE business_id = $1 AND code = '2400'", [biz.id]);
    const inventoryEventId = await newInventoryEventId();
    const client = await dbLib.getPool().connect();
    let entryId: string | null;
    try {
      await client.query("BEGIN");
      entryId = await ledgerService.postExactOrderPaymentEntry(client, {
        businessId: biz.id,
        locationId: biz.locationId,
        orderId: randomUUID(),
        createdBy: null,
        method: "cash",
        amount: "50000" as RialText,
        tax: "0" as RialText,
        inventoryEventId,
        orderChannel: "dine_in",
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(entryId).not.toBeNull();
  });

  it("fails with a missing-account error when a tip is given but tipsPayable is missing from the chart", async () => {
    await db.query("DELETE FROM accounts WHERE business_id = $1 AND code = '2400'", [biz.id]);
    const inventoryEventId = await newInventoryEventId();
    const client = await dbLib.getPool().connect();
    try {
      await client.query("BEGIN");
      await expect(
        ledgerService.postExactOrderPaymentEntry(client, {
          businessId: biz.id,
          locationId: biz.locationId,
          orderId: randomUUID(),
          createdBy: null,
          method: "cash",
          amount: "50000" as RialText,
          tax: "0" as RialText,
          inventoryEventId,
          orderChannel: "dine_in",
          tip: "5000" as RialText,
        }),
      ).rejects.toThrow(ledgerService.MissingLedgerAccountError);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});
