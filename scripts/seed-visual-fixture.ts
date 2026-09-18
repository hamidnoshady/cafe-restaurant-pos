/**
 * Deterministic fixture for the visual-regression baselines.
 *
 * `npm run db:seed` deliberately seeds only enough to log in: a business, a
 * location and two users. That is right for development, but it is *wrong* for
 * a visual baseline — every table photographs as its empty state, so a baseline
 * recorded against it cannot catch a regression in how a row, an amount or a
 * status badge renders. Which is most of what the design system does.
 *
 * So this adds a small, fixed cast of rows on top of the ordinary seed:
 * a chart of accounts with a posted journal entry, three warehouse items with
 * stock, three parties and three CRM deals.
 *
 * Every value here is **hard-coded on purpose**. No `Math.random`, no
 * `new Date()`, no faker: a fixture that varies produces a baseline that
 * disagrees with itself on the next run, the check gets marked flaky, and a
 * flaky check is not a check. Dates are fixed Gregorian instants chosen to land
 * on unremarkable Jalali days, and money is in integer Rial, which is how the
 * app stores it — the UI converts to the business's selected display unit.
 *
 * Idempotent: it keys every row on a stable natural key and skips what exists,
 * so re-running it before a re-record does not double the data.
 *
 * Usage: npm run db:seed:visual   (run `npm run db:seed` first)
 */
import "dotenv/config";
import { Client } from "pg";

/** A fixed instant, so "last changed" columns never drift. */
const T0 = "2026-03-15T08:30:00.000Z";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");
    // Fixtures span the tenant boundary the same way seeding does.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const business = await client.query("SELECT id FROM businesses ORDER BY created_at LIMIT 1");
    if (!business.rowCount) {
      throw new Error("No business found. Run `npm run db:seed` first.");
    }
    const businessId = business.rows[0].id as string;

    const location = await client.query(
      "SELECT id FROM locations WHERE business_id = $1 ORDER BY created_at LIMIT 1",
      [businessId],
    );
    if (!location.rowCount) throw new Error("No location found. Run `npm run db:seed` first.");
    const locationId = location.rows[0].id as string;

    // ---- Chart of accounts -------------------------------------------------
    // Four accounts, enough for the trial balance to show a real hierarchy and
    // a balanced pair of totals rather than «هنوز سندی ثبت نشده است».
    // `normal_balance` is a generated column derived from `type`, so it is not
    // written here — the database decides debit/credit from the account type.
    const ACCOUNTS: Array<{ code: string; name: string; type: string }> = [
      { code: "1010", name: "صندوق", type: "asset" },
      { code: "1020", name: "بانک ملت", type: "asset" },
      { code: "4010", name: "فروش کافه", type: "revenue" },
      { code: "5010", name: "خرید مواد اولیه", type: "expense" },
    ];
    const accountIds = new Map<string, string>();
    for (const account of ACCOUNTS) {
      const existing = await client.query(
        "SELECT id FROM accounts WHERE business_id = $1 AND code = $2",
        [businessId, account.code],
      );
      if (existing.rowCount) {
        accountIds.set(account.code, existing.rows[0].id);
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO accounts (business_id, code, name, type, level)
         VALUES ($1, $2, $3, $4::account_type, 'moein'::account_level) RETURNING id`,
        [businessId, account.code, account.name, account.type],
      );
      accountIds.set(account.code, inserted.rows[0].id);
    }

    // ---- A posted journal entry -------------------------------------------
    // Balanced by construction: a cash sale of 4,500,000 Rial and the purchase
    // that supplied it. Two entries so the trial balance has more than one row
    // per side and its totals are worth reading.
    const ENTRIES: Array<{
      memo: string;
      date: string;
      lines: Array<{ code: string; debit: number; credit: number }>;
    }> = [
      {
        memo: "فروش نقدی روز",
        date: "2026-03-10",
        lines: [
          { code: "1010", debit: 45_000_000, credit: 0 },
          { code: "4010", debit: 0, credit: 45_000_000 },
        ],
      },
      {
        memo: "خرید دانه قهوه",
        date: "2026-03-12",
        lines: [
          { code: "5010", debit: 18_000_000, credit: 0 },
          { code: "1020", debit: 0, credit: 18_000_000 },
        ],
      },
    ];
    for (const entry of ENTRIES) {
      const existing = await client.query(
        "SELECT id FROM journal_entries WHERE business_id = $1 AND memo = $2",
        [businessId, entry.memo],
      );
      if (existing.rowCount) continue;
      const created = await client.query(
        `INSERT INTO journal_entries (business_id, location_id, entry_date, memo, source_type, posted_at)
         VALUES ($1, $2, $3, $4, 'fixture', $5) RETURNING id`,
        [businessId, locationId, entry.date, entry.memo, T0],
      );
      const entryId = created.rows[0].id as string;
      for (const line of entry.lines) {
        await client.query(
          "INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES ($1, $2, $3, $4)",
          [entryId, accountIds.get(line.code), line.debit, line.credit],
        );
      }
    }

    // ---- Inventory ---------------------------------------------------------
    // Three items with stock, so the warehouse table shows counts, a money
    // column and a low-stock badge instead of one empty branch row.
    const ITEMS: Array<{ name: string; sku: string; unit: string; qty: number; cost: number; reorder: number }> = [
      { name: "دانه قهوه عربیکا", sku: "CF-ARB-1", unit: "کیلوگرم", qty: 24, cost: 1_850_000, reorder: 10 },
      { name: "شیر پرچرب", sku: "MK-FULL-1", unit: "لیتر", qty: 6, cost: 420_000, reorder: 20 },
      { name: "شکر سفید", sku: "SG-WHT-1", unit: "کیلوگرم", qty: 40, cost: 310_000, reorder: 15 },
    ];
    for (const item of ITEMS) {
      const existing = await client.query(
        "SELECT id FROM inventory_items WHERE location_id = $1 AND sku = $2",
        [locationId, item.sku],
      );
      const itemId = existing.rowCount
        ? (existing.rows[0].id as string)
        : ((
            await client.query(
              `INSERT INTO inventory_items (location_id, name, sku, unit, reorder_level, avg_cost, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
              [locationId, item.name, item.sku, item.unit, item.reorder, item.cost, T0],
            )
          ).rows[0].id as string);

      // Stock is derived from `stock_movements`, not stored as a level — the
      // warehouse list sums movements per item. (`item_stock` is the *retail*
      // `items` table's companion and is a different subsystem.) So the
      // fixture records an opening purchase, which is also how the real app
      // would have got this stock there.
      const opening = await client.query(
        "SELECT 1 FROM stock_movements WHERE inventory_item_id = $1 AND source_type = 'fixture'",
        [itemId],
      );
      if (!opening.rowCount) {
        await client.query(
          `INSERT INTO stock_movements
             (location_id, inventory_item_id, type, quantity, unit_cost, source_type, note, occurred_at, cost_value_rial)
           VALUES ($1, $2, 'purchase'::stock_movement_type, $3, $4, 'fixture', 'موجودی اولیه', $5, $6)`,
          [locationId, itemId, item.qty, item.cost, T0, Math.round(item.qty * item.cost)],
        );
      }
    }

    // ---- Parties and CRM ---------------------------------------------------
    const PARTIES: Array<{ name: string; phone: string; role: string }> = [
      { name: "سارا محمدی", phone: "09121110001", role: "customer" },
      { name: "رضا کریمی", phone: "09121110002", role: "customer" },
      { name: "پخش مواد غذایی آریا", phone: "02144440003", role: "supplier" },
    ];
    const partyIds = new Map<string, string>();
    for (const party of PARTIES) {
      const existing = await client.query(
        "SELECT id FROM parties WHERE business_id = $1 AND name = $2",
        [businessId, party.name],
      );
      if (existing.rowCount) {
        partyIds.set(party.name, existing.rows[0].id);
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO parties (business_id, location_id, name, phone, role, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, true, $6) RETURNING id`,
        [businessId, locationId, party.name, party.phone, party.role, T0],
      );
      partyIds.set(party.name, inserted.rows[0].id);
    }

    const DEALS: Array<{ title: string; stage: string; value: number; customer: string }> = [
      { title: "قرارداد پذیرایی هفتگی", stage: "qualified", value: 120_000_000, customer: "سارا محمدی" },
      { title: "سفارش عمده دانه قهوه", stage: "proposal", value: 85_000_000, customer: "رضا کریمی" },
      { title: "تأمین ماهانه شیر", stage: "won", value: 46_000_000, customer: "سارا محمدی" },
    ];
    for (const deal of DEALS) {
      const existing = await client.query(
        "SELECT id FROM crm_deals WHERE business_id = $1 AND title = $2",
        [businessId, deal.title],
      );
      if (existing.rowCount) continue;
      await client.query(
        `INSERT INTO crm_deals (business_id, customer_id, title, stage, value_rial, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [businessId, partyIds.get(deal.customer), deal.title, deal.stage, deal.value, T0],
      );
    }

    await client.query("COMMIT");
    console.log(
      "Visual fixture ready: 4 accounts, 2 journal entries, 3 inventory items, 3 parties, 3 deals.",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
