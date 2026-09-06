/**
 * Phase 26 (issue #125) Wave 3 — base-data import (goods, persons, accounts).
 *
 * DB-touching (not unit-tested directly; the pure planning lives in
 * import-plan.ts). The importer is split into preview (no writes — what would
 * happen) and apply (write, then record a mapping row per created entity), so
 * a run is idempotent and every later wave (rollback in Wave 6, ownership in
 * Wave 7) can answer "who made this row" from integration_mappings alone.
 *
 * Goods route is chosen from the business's industry `salesModel`
 * (`menu_items` for order-ticket food service, `items`/`item_stock` for the
 * retail trades), not by a hand-written industry branch.
 */
import Decimal from "decimal.js";
import { getPool, query } from "../../db";
import { getBusinessIndustry } from "../../industry-guard";
import { industryProfile } from "../../industry-profile";
import { getConnection } from "../connections-service";
import { localIdForRemote, upsertMapping } from "../mapping-service";
import { coaTemplateForIndustry, WELL_KNOWN_CODES } from "../../coa-template";
import { getSetting, SETTING_KEYS } from "../../settings";
import { planAccountImport, planGoods, planPersons, holooAccountType } from "./import-plan";
import type { MappedAccount, MappedGoods, MappedOpeningInventory, MappedPerson } from "./mappers";
import { createParty } from "../../parties-service";

async function resolveLocationId(businessId: string, connectionLocationId: string | null): Promise<string> {
  if (connectionLocationId) return connectionLocationId;
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  if (!rows[0]) throw new Error("no_location");
  return rows[0].id;
}

async function alreadyMapped(businessId: string, connectionId: string, entityType: Parameters<typeof localIdForRemote>[2], remoteIds: string[]): Promise<Set<string>> {
  const mapped = new Set<string>();
  for (const remoteId of remoteIds) {
    if (await localIdForRemote(businessId, connectionId, entityType, remoteId)) mapped.add(remoteId);
  }
  return mapped;
}

function openingValueRial(quantity: string, unitCostRial: bigint): string {
  return new Decimal(quantity).times(unitCostRial.toString()).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

async function applyOpeningInventory(
  businessId: string,
  connectionId: string,
  locationId: string,
  rows: MappedOpeningInventory[],
  createdBy: string | null,
  importRunId?: string | null,
): Promise<number> {
  if (rows.length === 0) return 0;
  const stockMapped = await alreadyMapped(businessId, connectionId, "holoo_stock", rows.map((row) => row.remoteId));
  const toImport = rows.filter((row) => !stockMapped.has(row.remoteId));
  if (toImport.length === 0) return 0;

  const costing = await getSetting<{ method?: "fifo" | "weighted_average"; lockedAt?: string | null }>(businessId, SETTING_KEYS.costing);
  const method = costing?.method ?? "fifo";
  const client = await getPool().connect();
  let eventId: string | null = null;
  let imported = 0;
  let totalValue = 0n;
  try {
    await client.query("BEGIN");
    const { rows: existingOpening } = await client.query<{ id: string; source_type: string }>(
      `SELECT id, source_type FROM inventory_events
        WHERE business_id = $1 AND event_type = 'opening'
        ORDER BY created_at LIMIT 1 FOR UPDATE`,
      [businessId],
    );
    if (existingOpening[0]) {
      // Opening inventory is a cutover document, not a periodic stock feed.
      // If any opening event already exists (manual setup or Holoo), the run is
      // idempotent and no second opening layer is created.
      await client.query("ROLLBACK");
      return 0;
    }

    const { rows: eventRows } = await client.query<{ id: string }>(
      `INSERT INTO inventory_events
         (business_id, location_id, event_type, source_type, source_id, created_by, costing_version, metadata)
       VALUES ($1, $2, 'opening', 'holoo_import', $3, $4, 2, $5)
       RETURNING id`,
      [businessId, locationId, importRunId ?? null, createdBy, JSON.stringify({ connectionId })],
    );
    eventId = eventRows[0].id;

    for (const row of toImport) {
      const quantity = new Decimal(row.quantity);
      if (!quantity.isFinite() || quantity.lte(0)) continue;
      const costValue = openingValueRial(row.quantity, row.unitCostRial);
      totalValue += BigInt(costValue);
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM inventory_items WHERE location_id = $1 AND name = $2 ORDER BY created_at LIMIT 1 FOR UPDATE`,
        [locationId, row.name],
      );
      let itemId = existing[0]?.id;
      if (!itemId) {
        const { rows: itemRows } = await client.query<{ id: string }>(
          `INSERT INTO inventory_items (location_id, name, sku, unit, avg_cost, carrying_value_rial)
           VALUES ($1, $2, NULL, $3, $4, CASE WHEN $6 = 'weighted_average' THEN $5::bigint ELSE NULL END)
           RETURNING id`,
          [locationId, row.name, row.unit ?? "unit", row.unitCostRial.toString(), costValue, method],
        );
        itemId = itemRows[0].id;
      } else if (method === "weighted_average") {
        await client.query(
          `UPDATE inventory_items SET avg_cost = $2, carrying_value_rial = COALESCE(carrying_value_rial, 0) + $3::bigint WHERE id = $1`,
          [itemId, row.unitCostRial.toString(), costValue],
        );
      }

      await client.query(
        `INSERT INTO stock_movements
           (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial,
            source_type, source_id, note, created_by, inventory_event_id)
         VALUES ($1, $2, 'adjustment', $3, $4, $5, 'opening', $6, 'موجودی افتتاحیه از هلو', $7, $6)`,
        [locationId, itemId, row.quantity, row.unitCostRial.toString(), costValue, eventId, createdBy],
      );
      if (method === "fifo") {
        await client.query(
          `INSERT INTO inventory_lots
             (location_id, inventory_item_id, remaining_qty, unit_cost, source_type, source_id,
              inventory_event_id, original_quantity, original_value_rial, remaining_value_rial)
           VALUES ($1, $2, $3, $4, 'opening', $5, $5, $3, $6, $6)`,
          [locationId, itemId, row.quantity, row.unitCostRial.toString(), eventId, costValue],
        );
      }
      imported += 1;
    }

    if (totalValue > 0n) {
      const { rows: accounts } = await client.query<{ id: string; code: string }>(
        `SELECT id, code FROM accounts WHERE business_id = $1 AND code = ANY($2::text[]) AND is_active`,
        [businessId, [WELL_KNOWN_CODES.inventory, WELL_KNOWN_CODES.openingEquity]],
      );
      const byCode = new Map(accounts.map((account) => [account.code, account.id]));
      const inventoryAccount = byCode.get(WELL_KNOWN_CODES.inventory);
      const openingEquity = byCode.get(WELL_KNOWN_CODES.openingEquity);
      if (!inventoryAccount || !openingEquity) throw new Error("opening_accounts_missing");
      await client.query(
        `INSERT INTO journal_entries
           (business_id, location_id, entry_date, memo, source_type, source_id, created_by, posting_kind, inventory_event_id)
         VALUES ($1, $2, CURRENT_DATE, 'موجودی افتتاحیه از هلو', 'opening_inventory', $3, $4, 'inventory', $3)
         ON CONFLICT (business_id, source_type, source_id, posting_kind) WHERE source_id IS NOT NULL AND posting_kind IS NOT NULL DO NOTHING`,
        [businessId, locationId, eventId, createdBy],
      );
      const { rows: entryRows } = await client.query<{ id: string }>(
        `SELECT id FROM journal_entries
          WHERE business_id = $1 AND source_type = 'opening_inventory' AND source_id = $2 AND posting_kind = 'inventory'`,
        [businessId, eventId],
      );
      const entryId = entryRows[0]?.id;
      if (entryId) {
        await client.query(`DELETE FROM journal_lines WHERE entry_id = $1`, [entryId]);
        await client.query(
          `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
           VALUES ($1, $2, $3, 0), ($1, $4, 0, $3)`,
          [entryId, inventoryAccount, totalValue.toString(), openingEquity],
        );
      }
      await client.query("UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1", [eventId]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (!eventId) return 0;
  for (const row of toImport.slice(0, imported)) {
    await upsertMapping(businessId, connectionId, "holoo_stock", row.remoteId, eventId, importRunId);
  }
  return imported;
}

export interface BaseImportInput {
  goods: MappedGoods[];
  persons: MappedPerson[];
  accounts: MappedAccount[];
  /** Opening on-hand stock at the migration/companion cutover. */
  openingInventory?: MappedOpeningInventory[];
}

export interface BaseImportPreview {
  goods: { toCreate: number; skipped: number };
  persons: { toCreate: number; skipped: number };
  accounts: { mappedToSeed: number; toCreate: number; orphaned: number };
  openingInventory: { toImport: number; skipped: number };
}

export interface BaseImportSummary extends BaseImportPreview {
  created: { goods: number; persons: number; accounts: number; openingInventory: number };
}

/** The plan, with no writes — what `apply` will do. */
export async function previewBaseImport(
  businessId: string,
  connectionId: string,
  input: BaseImportInput,
): Promise<BaseImportPreview> {
  const goodsMapped = await alreadyMapped(businessId, connectionId, "holoo_goods", input.goods.map((g) => g.remoteId));
  const personsMapped = await alreadyMapped(businessId, connectionId, "holoo_customer", input.persons.map((p) => p.remoteId));
  const inventoryRows = input.openingInventory ?? [];
  const stockMapped = await alreadyMapped(businessId, connectionId, "holoo_stock", inventoryRows.map((row) => row.remoteId));

  const goods = planGoods(input.goods, goodsMapped);
  const persons = planPersons(input.persons, personsMapped);

  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";
  const seedCodes = new Set(coaTemplateForIndustry(industry).map((a) => a.code));
  const accounts = planAccountImport(input.accounts, seedCodes);

  return {
    goods: { toCreate: goods.toCreate.length, skipped: goods.skipped },
    persons: { toCreate: persons.toCreate.length, skipped: persons.skipped },
    accounts: { mappedToSeed: accounts.mappedToSeed.length, toCreate: accounts.toCreate.length, orphaned: accounts.orphaned.length },
    openingInventory: { toImport: inventoryRows.filter((row) => !stockMapped.has(row.remoteId)).length, skipped: stockMapped.size },
  };
}

/** Apply the base import, recording a mapping row per created entity. */
export async function applyBaseImport(
  businessId: string,
  connectionId: string,
  input: BaseImportInput,
  importRunId?: string | null,
): Promise<BaseImportSummary> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const locationId = await resolveLocationId(businessId, connection.location_id);
  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";
  const isFoodService = industryProfile(industry).salesModel === "order_ticket";

  let createdGoods = 0;
  let createdPersons = 0;
  let createdAccounts = 0;
  let createdOpeningInventory = 0;

  const goodsMapped = await alreadyMapped(businessId, connectionId, "holoo_goods", input.goods.map((g) => g.remoteId));
  const goodsPlan = planGoods(input.goods, goodsMapped);
  for (const goods of goodsPlan.toCreate) {
    let localId: string;
    if (isFoodService) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO menu_items (location_id, name, sku, price)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [locationId, goods.name, goods.sku, goods.priceRial === null ? 0n : goods.priceRial],
      );
      localId = rows[0].id;
    } else {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO items (location_id, name, sku, kind, tracking)
         VALUES ($1, $2, $3, 'simple', 'none') RETURNING id`,
        [locationId, goods.name, goods.sku],
      );
      localId = rows[0].id;
      await query(
        `INSERT INTO item_stock (item_id, quantity, unit_price)
         VALUES ($1, 0, $2)`,
        [localId, goods.priceRial === null ? null : Number(goods.priceRial)],
      );
    }
    await upsertMapping(businessId, connectionId, "holoo_goods", goods.remoteId, localId, importRunId);
    createdGoods += 1;
  }

  const personsMapped = await alreadyMapped(businessId, connectionId, "holoo_customer", input.persons.map((p) => p.remoteId));
  const personsPlan = planPersons(input.persons, personsMapped);
  for (const person of personsPlan.toCreate) {
    // Suppliers go through the existing supplier path (the `suppliers` table,
    // keyed on location); the rest become parties. Both are recorded under the
    // same mapping kind — a Holoo person id is unique, and Wave 4 resolves the
    // right one per transaction type.
    //
    // The customer path used to be `INSERT INTO customers`. It goes through
    // `createParty` now because that is where a party's rules live: the Iranian
    // mobile is normalized before it is stored, and the ledger code is allocated in
    // the same statement. Raw SQL here would silently import `۰۹۱۲…` as Latin
    // digits with no code, and the two only exist in the service.
    let localId: string;
    if (person.isSupplier) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO suppliers (location_id, name, phone) VALUES ($1, $2, $3) RETURNING id`,
        [locationId, person.name, person.phone],
      );
      localId = rows[0].id;
    } else {
      localId = (await createParty(businessId, {
        displayName: person.name,
        phone: person.phone ?? null,
        address: person.address ?? null,
      })).id;
    }
    await upsertMapping(businessId, connectionId, "holoo_customer", person.remoteId, localId, importRunId);
    createdPersons += 1;
  }

  const seedCodes = new Set(coaTemplateForIndustry(industry).map((a) => a.code));
  const accountsPlan = planAccountImport(input.accounts, seedCodes);
  // Map accounts whose code already exists in the seed chart (don't recreate).
  for (const account of accountsPlan.mappedToSeed) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM accounts WHERE business_id = $1 AND code = $2`,
      [businessId, account.code],
    );
    if (rows[0]) await upsertMapping(businessId, connectionId, "holoo_account", account.remoteId, rows[0].id, importRunId);
  }
  // Create accounts with codes absent from the seed chart.
  for (const account of accountsPlan.toCreate) {
    const parentId = account.parentCode
      ? await localIdForRemote(businessId, connectionId, "holoo_account", account.parentCode)
      : null;
    const { rows } = await query<{ id: string }>(
      `INSERT INTO accounts (business_id, parent_id, code, name, type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [businessId, parentId, account.code, account.name, holooAccountType(account.code, account.nature)],
    );
    await upsertMapping(businessId, connectionId, "holoo_account", account.remoteId, rows[0].id, importRunId);
    createdAccounts += 1;
  }

  const openingInventoryRows = input.openingInventory ?? [];
  createdOpeningInventory = await applyOpeningInventory(
    businessId,
    connectionId,
    locationId,
    openingInventoryRows,
    null,
    importRunId,
  );
  const openingMapped = await alreadyMapped(businessId, connectionId, "holoo_stock", openingInventoryRows.map((row) => row.remoteId));

  return {
    goods: { toCreate: goodsPlan.toCreate.length, skipped: goodsPlan.skipped },
    persons: { toCreate: personsPlan.toCreate.length, skipped: personsPlan.skipped },
    accounts: { mappedToSeed: accountsPlan.mappedToSeed.length, toCreate: accountsPlan.toCreate.length, orphaned: accountsPlan.orphaned.length },
    openingInventory: { toImport: openingInventoryRows.filter((row) => !openingMapped.has(row.remoteId)).length + createdOpeningInventory, skipped: Math.max(0, openingMapped.size - createdOpeningInventory) },
    created: { goods: createdGoods, persons: createdPersons, accounts: createdAccounts, openingInventory: createdOpeningInventory },
  };
}
