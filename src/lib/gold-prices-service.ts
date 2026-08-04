/**
 * Phase 21 Wave 2 — daily gold price entry (DB-touching).
 *
 * DB-touching, so per repo convention (see gold.ts for the pure rules this
 * leans on) it has no direct unit test; covered instead by
 * integration/gold-prices.integration.test.ts.
 */
import { query } from "./db";
import { validateGoldPrice, type Purity } from "./gold";

export interface GoldPrice {
  id: string;
  businessId: string;
  purity: Purity;
  priceDate: string;
  pricePerGram: number;
  source: "manual" | "external";
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GoldPriceRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  purity: Purity;
  price_date: string;
  // bigint comes back from pg as a string, per project convention (see
  // ar-service.ts) -- converted to a plain number in mapGoldPrice, safely
  // within Number's precision for a per-gram Rial price.
  price_per_gram: string;
  source: "manual" | "external";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapGoldPrice(row: GoldPriceRow): GoldPrice {
  return {
    id: row.id,
    businessId: row.business_id,
    purity: row.purity,
    priceDate: row.price_date,
    pricePerGram: Number(row.price_per_gram),
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RecordGoldPriceInput {
  businessId: string;
  purity: string;
  pricePerGram: number;
  priceDate?: string;
  source?: "manual" | "external";
  createdBy?: string | null;
}

/** Records (or replaces) today's — or an explicit date's — price/gram for one purity. Manual entry is the default `source`; an external feed integration (Wave 2's optional hook, no provider wired up yet) would pass `source: 'external'`. */
export async function recordGoldPrice(input: RecordGoldPriceInput): Promise<GoldPrice> {
  const errors = validateGoldPrice(input.purity, input.pricePerGram);
  if (errors.length > 0) throw new Error(errors.join("؛ "));

  const { rows } = await query<GoldPriceRow>(
    `INSERT INTO gold_prices (business_id, purity, price_date, price_per_gram, source, created_by)
     VALUES ($1, $2, COALESCE($3, CURRENT_DATE), $4, $5, $6)
     ON CONFLICT (business_id, purity, price_date) DO UPDATE
       SET price_per_gram = EXCLUDED.price_per_gram, source = EXCLUDED.source,
           created_by = EXCLUDED.created_by, updated_at = now()
     RETURNING *`,
    [
      input.businessId,
      input.purity,
      input.priceDate ?? null,
      input.pricePerGram,
      input.source ?? "manual",
      input.createdBy ?? null,
    ],
  );
  return mapGoldPrice(rows[0]);
}

/** The latest price on or before `asOfDate` (defaults to today) for one purity — a business isn't required to re-enter a price every single day. */
export async function getGoldPrice(
  businessId: string,
  purity: string,
  asOfDate?: string,
): Promise<GoldPrice | null> {
  const { rows } = await query<GoldPriceRow>(
    `SELECT * FROM gold_prices
      WHERE business_id = $1 AND purity = $2 AND price_date <= COALESCE($3, CURRENT_DATE)
      ORDER BY price_date DESC LIMIT 1`,
    [businessId, purity, asOfDate ?? null],
  );
  return rows[0] ? mapGoldPrice(rows[0]) : null;
}

/** Every purity's latest price as of `asOfDate` (defaults to today) — the day's full price board. */
export async function listCurrentGoldPrices(businessId: string, asOfDate?: string): Promise<GoldPrice[]> {
  const { rows } = await query<GoldPriceRow>(
    `SELECT DISTINCT ON (purity) *
       FROM gold_prices
      WHERE business_id = $1 AND price_date <= COALESCE($2, CURRENT_DATE)
      ORDER BY purity, price_date DESC`,
    [businessId, asOfDate ?? null],
  );
  return rows.map(mapGoldPrice);
}
