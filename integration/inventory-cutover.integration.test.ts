import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { applyInventoryCutover, dryRunInventoryCutover } from "../src/lib/inventory-cutover";

const configuredUrl = process.env.DATABASE_URL;
if (!configuredUrl) throw new Error("DATABASE_URL is required for database integration tests");

let databaseName = "";
let databaseUrl = "";

function urlFor(database: string): string {
  const url = new URL(configuredUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

async function connect(url = databaseUrl): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

beforeAll(async () => {
  databaseName = `pos_cutover_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = await connect(urlFor("postgres"));
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  databaseUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl, quiet: true });
});

afterAll(async () => {
  const admin = await connect(urlFor("postgres"));
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  await admin.end();
});

describe("audited inventory cutover", () => {
  it("keeps dry-run immutable, applies idempotently, and marks unknown historical COGS unavailable", async () => {
    const client = await connect();
    const fixture = await client.query<{
      location_id: string;
      owner_id: string;
      inventory_item_id: string;
    }>(`
      WITH business AS (
        INSERT INTO businesses(name) VALUES('Cutover Test') RETURNING id
      ), location AS (
        INSERT INTO locations(business_id,name) SELECT id,'Main' FROM business RETURNING id,business_id
      ), owner_user AS (
        INSERT INTO users(business_id,role,full_name,password_hash)
        SELECT business_id,'owner','Owner','test-hash' FROM location RETURNING id
      ), accounts_created AS (
        INSERT INTO accounts(business_id,code,name,type)
        SELECT business_id,code,name,type::account_type FROM location CROSS JOIN (VALUES
          ('1300','Inventory','asset'),('3950','History Equity','equity')
        ) a(code,name,type)
      ), item AS (
        INSERT INTO inventory_items(location_id,name,unit,avg_cost)
        SELECT id,'Legacy item','unit',0 FROM location RETURNING id,location_id
      ), legacy_order AS (
        INSERT INTO orders(location_id,order_number,status,total,closed_at)
        SELECT location_id,1,'completed',100,'2026-07-23T00:00:00Z'::timestamptz FROM item
      )
      SELECT location.id location_id,owner_user.id owner_id,item.id inventory_item_id
      FROM location,owner_user,item
    `);
    const row = fixture.rows[0];
    const manifest = {
      locationId: row.location_id,
      effectiveAt: "2026-07-24T00:00:00.000Z",
      approvedBy: row.owner_id,
      backupConfirmation: "backup-verified-test",
      evidenceSha256: "b".repeat(64),
      lines: [{
        inventoryItemId: row.inventory_item_id,
        physicalQuantity: "2.5",
        carryingValueRial: "250",
        sourceClassification: "source_backed" as const,
        evidence: { countSheet: "test" },
      }],
    };

    const dryRun = await dryRunInventoryCutover(client as never, manifest);
    expect(dryRun.completedOrders).toEqual({ exact: 0, unavailable: 1 });
    expect((await client.query("SELECT count(*)::int count FROM inventory_cutovers")).rows[0].count).toBe(0);

    await client.query("BEGIN");
    const applied = await applyInventoryCutover(client as never, manifest);
    await client.query("COMMIT");
    expect(applied.duplicate).toBe(false);

    await client.query("BEGIN");
    const duplicate = await applyInventoryCutover(client as never, manifest);
    await client.query("COMMIT");
    expect(duplicate).toMatchObject({ cutoverId: applied.cutoverId, duplicate: true });

    const verified = await client.query<{
      status: string;
      quantity: string;
      value: string;
      classification: string;
      cogs_available: boolean;
      journal_difference: string;
    }>(
      `SELECT c.status::text,
        trim_scale((SELECT sum(quantity) FROM stock_movements WHERE inventory_item_id=$2))::text quantity,
        (SELECT remaining_value_rial::text FROM inventory_lots WHERE inventory_item_id=$2 AND remaining_qty>0) value,
        h.classification::text,h.cogs_available,
        COALESCE((SELECT sum(jl.debit-jl.credit)::text FROM journal_lines jl
          WHERE jl.entry_id=c.reconciliation_journal_id),'0') journal_difference
       FROM inventory_cutovers c
       JOIN inventory_history_coverage h ON h.cutover_id=c.id AND h.source_type='order'
       WHERE c.id=$1`,
      [applied.cutoverId, row.inventory_item_id],
    );
    expect(verified.rows[0]).toEqual({
      status: "applied",
      quantity: "2.5",
      value: "250",
      classification: "unavailable",
      cogs_available: false,
      journal_difference: "0",
    });
    await expect(
      client.query("UPDATE inventory_cutovers SET backup_confirmation='changed-value' WHERE id=$1", [
        applied.cutoverId,
      ]),
    ).rejects.toMatchObject({ message: "applied inventory cutover records are immutable" });
    await client.end();
  });
});
