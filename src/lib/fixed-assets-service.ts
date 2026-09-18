/**
 * Phase 22 Wave 5, second slice — fixed-asset register & depreciation
 * (issue #160 §2), the DB-touching part. Pure math lives in
 * depreciation.ts (validateFixedAsset, monthlyDepreciation,
 * depreciationForPeriod) and is what depreciation.test.ts covers.
 *
 * accumulatedDepreciation/bookValue are always reconstructed from
 * fixed_asset_depreciation_entries — never a shadow column on the asset
 * row — the same discipline ar-service.ts/ap-service.ts already use for
 * their control-account balances. Depreciation posts a real, immediate
 * entry (Debit depreciationExpense / Credit accumulatedDepreciation)
 * through the same postJournalEntry() every other posting path uses, so
 * it's subject to the fiscal-period lock exactly like everything else.
 */
import { getPool, query } from "./db";
import { accountIdsByCode, postJournalEntry } from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { depreciationForPeriod, validateFixedAsset, type DepreciableAsset } from "./depreciation";

export class FixedAssetError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface FixedAsset {
  id: string;
  name: string;
  acquisitionDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  accumulatedDepreciation: number;
  bookValue: number;
  createdAt: string;
  depreciationCount?: number;
  locationId?: string | null;
  locationName?: string | null;
}

export interface FixedAssetDepreciationEntry {
  id: string;
  fixedAssetId: string;
  periodLabel: string;
  entryDate: string;
  amount: number;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  journalEntryId: string | null;
}

interface FixedAssetRow extends Record<string, unknown> {
  id: string;
  name: string;
  acquisition_date: string;
  cost: string;
  salvage_value: string;
  useful_life_months: number;
  accumulated_depreciation: string;
  created_at: string;
  depreciation_count?: number;
  location_id?: string | null;
  location_name?: string | null;
}

const SELECT_FIXED_ASSETS = `
  SELECT fa.id, fa.location_id, l.name AS location_name, fa.name,
         fa.acquisition_date::text AS acquisition_date, fa.cost::text AS cost,
         fa.salvage_value::text AS salvage_value, fa.useful_life_months, fa.created_at::text AS created_at,
         COALESCE(SUM(d.amount), 0)::text AS accumulated_depreciation,
         COUNT(d.id)::int AS depreciation_count
    FROM fixed_assets fa
    LEFT JOIN locations l ON l.id = fa.location_id
    LEFT JOIN fixed_asset_depreciation_entries d ON d.fixed_asset_id = fa.id
   WHERE fa.business_id = $1
   GROUP BY fa.id, l.name
   ORDER BY fa.acquisition_date DESC, fa.created_at DESC`;

function toFixedAsset(r: FixedAssetRow): FixedAsset {
  const cost = Number(r.cost);
  const accumulatedDepreciation = Number(r.accumulated_depreciation);
  return {
    id: r.id,
    name: r.name,
    acquisitionDate: r.acquisition_date,
    cost,
    salvageValue: Number(r.salvage_value),
    usefulLifeMonths: r.useful_life_months,
    accumulatedDepreciation,
    bookValue: cost - accumulatedDepreciation,
    createdAt: r.created_at,
    depreciationCount: Number(r.depreciation_count ?? 0),
    locationId: (r.location_id as string) ?? null,
    locationName: (r.location_name as string) ?? null,
  };
}

export async function listFixedAssets(businessId: string): Promise<FixedAsset[]> {
  const { rows } = await query<FixedAssetRow>(SELECT_FIXED_ASSETS, [businessId]);
  return rows.map(toFixedAsset);
}

export async function getFixedAssetWithDepreciation(
  businessId: string,
  id: string,
): Promise<{
  fixedAsset: FixedAsset;
  depreciationEntries: FixedAssetDepreciationEntry[];
}> {
  const { rows } = await query<FixedAssetRow>(
    `SELECT fa.id, fa.location_id, l.name AS location_name, fa.name,
            fa.acquisition_date::text AS acquisition_date, fa.cost::text AS cost,
            fa.salvage_value::text AS salvage_value, fa.useful_life_months, fa.created_at::text AS created_at,
            COALESCE(SUM(d.amount), 0)::text AS accumulated_depreciation,
            COUNT(d.id)::int AS depreciation_count
       FROM fixed_assets fa
       LEFT JOIN locations l ON l.id = fa.location_id
       LEFT JOIN fixed_asset_depreciation_entries d ON d.fixed_asset_id = fa.id
      WHERE fa.business_id = $1 AND fa.id = $2
      GROUP BY fa.id, l.name`,
    [businessId, id],
  );
  if (!rows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);

  const { rows: entries } = await query<{
    id: string;
    fixed_asset_id: string;
    period_label: string;
    entry_date: string;
    amount: string;
    created_by: string | null;
    created_by_name: string | null;
    created_at: string;
    journal_entry_id: string | null;
  }>(
    `SELECT d.id, d.fixed_asset_id, d.period_label, d.entry_date::text AS entry_date,
            d.amount::text AS amount, d.created_by, u.full_name AS created_by_name,
            d.created_at::text AS created_at, je.id AS journal_entry_id
       FROM fixed_asset_depreciation_entries d
       JOIN fixed_assets fa ON fa.id = d.fixed_asset_id
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN journal_entries je ON je.source_type = 'fixed_asset_depreciation' AND je.source_id = d.id
      WHERE fa.business_id = $1 AND d.fixed_asset_id = $2
      ORDER BY d.entry_date DESC, d.created_at DESC`,
    [businessId, id],
  );

  return {
    fixedAsset: toFixedAsset(rows[0]),
    depreciationEntries: entries.map((e) => ({
      id: e.id,
      fixedAssetId: e.fixed_asset_id,
      periodLabel: e.period_label,
      entryDate: e.entry_date,
      amount: Number(e.amount),
      createdBy: e.created_by,
      createdByName: e.created_by_name,
      createdAt: e.created_at,
      journalEntryId: e.journal_entry_id,
    })),
  };
}

export async function createFixedAsset(params: {
  businessId: string;
  locationId: string | null;
  name: string;
  acquisitionDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  createdBy: string | null;
}): Promise<FixedAsset> {
  const errors = validateFixedAsset(params);
  if (errors.length > 0) throw new FixedAssetError(errors.join(" "));

  const { rows } = await query<{ id: string; acquisition_date: string; created_at: string }>(
    `INSERT INTO fixed_assets (business_id, location_id, name, acquisition_date, cost, salvage_value, useful_life_months, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, acquisition_date::text AS acquisition_date, created_at::text AS created_at`,
    [
      params.businessId,
      params.locationId,
      params.name.trim(),
      params.acquisitionDate,
      params.cost,
      params.salvageValue,
      params.usefulLifeMonths,
      params.createdBy,
    ],
  );
  // Freshly created — no depreciation posted yet, so the reconstructed
  // totals are trivially known without a round trip through listFixedAssets.
  return {
    id: rows[0].id,
    name: params.name.trim(),
    acquisitionDate: rows[0].acquisition_date,
    cost: params.cost,
    salvageValue: params.salvageValue,
    usefulLifeMonths: params.usefulLifeMonths,
    accumulatedDepreciation: 0,
    bookValue: params.cost,
    createdAt: rows[0].created_at,
    depreciationCount: 0,
    locationId: params.locationId,
    locationName: null,
  };
}

/** Only ever succeeds for an asset with no depreciation posted yet — otherwise the history it caused would go missing. */
export async function deleteFixedAsset(businessId: string, id: string): Promise<void> {
  const { rows } = await query<{ id: string }>(`SELECT id FROM fixed_assets WHERE business_id = $1 AND id = $2`, [
    businessId,
    id,
  ]);
  if (!rows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);

  const { rows: depreciated } = await query(`SELECT 1 FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = $1 LIMIT 1`, [
    id,
  ]);
  if (depreciated.length > 0) throw new FixedAssetError("fixed_asset_has_depreciation", 409);

  await query(`DELETE FROM fixed_assets WHERE business_id = $1 AND id = $2`, [businessId, id]);
}

/**
 * Posts one period's straight-line depreciation for one asset: computes the
 * amount from what's already accumulated (capped at the depreciable base),
 * records it, and posts Debit depreciationExpense / Credit
 * accumulatedDepreciation. Rejects a duplicate `periodLabel` for this asset
 * (the DB's own UNIQUE constraint backs this — see migration 0058) and an
 * asset that's already fully depreciated.
 */
export async function postDepreciation(params: {
  businessId: string;
  locationId: string | null;
  fixedAssetId: string;
  periodLabel: string;
  entryDate?: string | null;
  createdBy: string | null;
}): Promise<{ amount: number }> {
  const periodLabel = params.periodLabel.trim();
  if (!periodLabel) throw new FixedAssetError("period_label_required");

  const { rows: assetRows } = await query<{
    cost: string;
    salvage_value: string;
    useful_life_months: number;
  }>(`SELECT cost::text AS cost, salvage_value::text AS salvage_value, useful_life_months FROM fixed_assets WHERE business_id = $1 AND id = $2`, [
    params.businessId,
    params.fixedAssetId,
  ]);
  if (!assetRows[0]) throw new FixedAssetError("fixed_asset_not_found", 404);
  const asset: DepreciableAsset = {
    cost: Number(assetRows[0].cost),
    salvageValue: Number(assetRows[0].salvage_value),
    usefulLifeMonths: assetRows[0].useful_life_months,
  };

  const { rows: accumulatedRows } = await query<{ total: string; count: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total, count(*)::text AS count
       FROM fixed_asset_depreciation_entries WHERE fixed_asset_id = $1`,
    [params.fixedAssetId],
  );
  const accumulatedSoFar = Number(accumulatedRows[0].total);
  const periodsPostedSoFar = Number(accumulatedRows[0].count);

  const amount = depreciationForPeriod(asset, accumulatedSoFar, periodsPostedSoFar);
  if (amount <= 0) throw new FixedAssetError("fully_depreciated", 409);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    let depreciationEntryId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO fixed_asset_depreciation_entries (fixed_asset_id, period_label, entry_date, amount, created_by)
         VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5) RETURNING id`,
        [params.fixedAssetId, periodLabel, params.entryDate?.trim() || null, amount, params.createdBy],
      );
      depreciationEntryId = rows[0].id;
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
        throw new FixedAssetError("period_already_depreciated", 409);
      }
      throw err;
    }

    const accounts = await accountIdsByCode(client, params.businessId, [
      WELL_KNOWN_CODES.depreciationExpense,
      WELL_KNOWN_CODES.accumulatedDepreciation,
    ]);
    await postJournalEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      entryDate: params.entryDate ?? null,
      memo: `استهلاک — ${periodLabel}`,
      sourceType: "fixed_asset_depreciation",
      sourceId: depreciationEntryId,
      createdBy: params.createdBy,
      lines: [
        { accountId: accounts.get(WELL_KNOWN_CODES.depreciationExpense)!, debit: amount, credit: 0 },
        { accountId: accounts.get(WELL_KNOWN_CODES.accumulatedDepreciation)!, debit: 0, credit: amount },
      ],
    });

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { amount };
}
