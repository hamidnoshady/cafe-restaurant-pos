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
import { query } from "../../db";
import { getBusinessIndustry } from "../../industry-guard";
import { industryProfile } from "../../industry-profile";
import { getConnection } from "../connections-service";
import { localIdForRemote, upsertMapping } from "../mapping-service";
import { coaTemplateForIndustry } from "../../coa-template";
import { planAccountImport, planGoods, planPersons, holooAccountType } from "./import-plan";
import type { MappedAccount, MappedGoods, MappedPerson } from "./mappers";

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

export interface BaseImportInput {
  goods: MappedGoods[];
  persons: MappedPerson[];
  accounts: MappedAccount[];
}

export interface BaseImportPreview {
  goods: { toCreate: number; skipped: number };
  persons: { toCreate: number; skipped: number };
  accounts: { mappedToSeed: number; toCreate: number; orphaned: number };
}

export interface BaseImportSummary extends BaseImportPreview {
  created: { goods: number; persons: number; accounts: number };
}

/** The plan, with no writes — what `apply` will do. */
export async function previewBaseImport(
  businessId: string,
  connectionId: string,
  input: BaseImportInput,
): Promise<BaseImportPreview> {
  const goodsMapped = await alreadyMapped(businessId, connectionId, "holoo_goods", input.goods.map((g) => g.remoteId));
  const personsMapped = await alreadyMapped(businessId, connectionId, "holoo_customer", input.persons.map((p) => p.remoteId));

  const goods = planGoods(input.goods, goodsMapped);
  const persons = planPersons(input.persons, personsMapped);

  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";
  const seedCodes = new Set(coaTemplateForIndustry(industry).map((a) => a.code));
  const accounts = planAccountImport(input.accounts, seedCodes);

  return {
    goods: { toCreate: goods.toCreate.length, skipped: goods.skipped },
    persons: { toCreate: persons.toCreate.length, skipped: persons.skipped },
    accounts: { mappedToSeed: accounts.mappedToSeed.length, toCreate: accounts.toCreate.length, orphaned: accounts.orphaned.length },
  };
}

/** Apply the base import, recording a mapping row per created entity. */
export async function applyBaseImport(
  businessId: string,
  connectionId: string,
  input: BaseImportInput,
): Promise<BaseImportSummary> {
  const connection = await getConnection(businessId, connectionId);
  if (!connection) throw new Error("not_found");
  const locationId = await resolveLocationId(businessId, connection.location_id);
  const industry = (await getBusinessIndustry(businessId)) ?? "food_service";
  const isFoodService = industryProfile(industry).salesModel === "order_ticket";

  let createdGoods = 0;
  let createdPersons = 0;
  let createdAccounts = 0;

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
    await upsertMapping(businessId, connectionId, "holoo_goods", goods.remoteId, localId);
    createdGoods += 1;
  }

  const personsMapped = await alreadyMapped(businessId, connectionId, "holoo_customer", input.persons.map((p) => p.remoteId));
  const personsPlan = planPersons(input.persons, personsMapped);
  for (const person of personsPlan.toCreate) {
    // Suppliers go through the existing supplier path (the `suppliers` table,
    // keyed on location); customers through `customers`. Both are recorded
    // under the same mapping kind — a Holoo person id is unique, and Wave 4
    // resolves the right one per transaction type.
    let localId: string;
    if (person.isSupplier) {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO suppliers (location_id, name, phone) VALUES ($1, $2, $3) RETURNING id`,
        [locationId, person.name, person.phone],
      );
      localId = rows[0].id;
    } else {
      const { rows } = await query<{ id: string }>(
        `INSERT INTO customers (business_id, location_id, name, phone, address)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [businessId, locationId, person.name, person.phone, person.address],
      );
      localId = rows[0].id;
    }
    await upsertMapping(businessId, connectionId, "holoo_customer", person.remoteId, localId);
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
    if (rows[0]) await upsertMapping(businessId, connectionId, "holoo_account", account.remoteId, rows[0].id);
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
    await upsertMapping(businessId, connectionId, "holoo_account", account.remoteId, rows[0].id);
    createdAccounts += 1;
  }

  return {
    goods: { toCreate: goodsPlan.toCreate.length, skipped: goodsPlan.skipped },
    persons: { toCreate: personsPlan.toCreate.length, skipped: personsPlan.skipped },
    accounts: { mappedToSeed: accountsPlan.mappedToSeed.length, toCreate: accountsPlan.toCreate.length, orphaned: accountsPlan.orphaned.length },
    created: { goods: createdGoods, persons: createdPersons, accounts: createdAccounts },
  };
}
