/**
 * Phase 27 Wave 3 — item brands (برند) as a first-class value (DB-touching).
 *
 * A brand is a shared value a shop enters once and attaches to items, so it
 * can be a filter, a report axis, and (Wave 7) a commission basis rather
 * than a free-text column that only ever matches itself. Scoped per branch,
 * like the items it labels.
 */
import { query, type PoolClient } from "./db";
import { validateServiceIntervalMonths } from "./watch";

export interface ItemBrand {
  id: string;
  locationId: string;
  name: string;
  country: string | null;
  productLine: string | null;
}

interface BrandRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  name: string;
  country: string | null;
  product_line: string | null;
}

function mapBrand(row: BrandRow): ItemBrand {
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    country: row.country,
    productLine: row.product_line,
  };
}

export async function listBrands(locationId: string): Promise<ItemBrand[]> {
  const { rows } = await query<BrandRow>(
    `SELECT * FROM item_brands WHERE location_id = $1 ORDER BY name`,
    [locationId],
  );
  return rows.map(mapBrand);
}

export async function createBrand(
  locationId: string,
  input: { name: string; country?: string | null; productLine?: string | null },
): Promise<ItemBrand> {
  const name = input.name?.trim();
  if (!name) throw new Error("نام برند نمی‌تواند خالی باشد.");
  const { rows } = await query<BrandRow>(
    `INSERT INTO item_brands (location_id, name, country, product_line)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [locationId, name, input.country?.trim() || null, input.productLine?.trim() || null],
  );
  return mapBrand(rows[0]);
}

export interface ItemProfileInput {
  brandId?: string | null;
  ircCode?: string | null;
  healthPermit?: string | null;
  authenticityRegistration?: string | null;
  /** Skin/hair-type tags — the caller sends the full desired list. */
  tags?: string[];
  /** Phase 27 Wave 10 — service interval in months (a quartz battery ~24, an automatic movement 36–60); null = no reminder. */
  serviceIntervalMonths?: number | null;
  /** Phase 27 Wave 11 — merchandising tags for sell-through reporting. */
  collection?: string | null;
  season?: string | null;
}

/** Sets an item's brand, regulatory fields, tags, service interval and merchandising tags to exactly what the caller sent (omitted = cleared). */
export async function updateItemProfile(
  itemId: string,
  input: ItemProfileInput,
  client?: PoolClient,
): Promise<void> {
  const intervalError = validateServiceIntervalMonths(input.serviceIntervalMonths);
  if (intervalError) throw new Error(intervalError);

  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);

  // Never allow a brand from another branch to be attached. The API checks
  // item ownership, but the service is also called by non-HTTP flows.
  if (input.brandId) {
    const { rows } = await run<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM item_brands b
         JOIN items i ON i.location_id = b.location_id
        WHERE b.id = $1 AND i.id = $2
       ) AS ok`,
      [input.brandId, itemId],
    );
    if (!rows[0]?.ok) throw new Error("برند انتخاب‌شده متعلق به شعبه این کالا نیست.");
  }

  await run(
    `UPDATE items SET
       brand_id = $2,
       irc_code = $3,
       health_permit = $4,
       authenticity_registration = $5,
       tags = $6,
       service_interval_months = $7,
       collection = $8,
       season = $9,
       updated_at = now()
     WHERE id = $1`,
    [
      itemId,
      input.brandId ?? null,
      input.ircCode?.trim() || null,
      input.healthPermit?.trim() || null,
      input.authenticityRegistration?.trim() || null,
      input.tags ?? [],
      input.serviceIntervalMonths ?? null,
      input.collection?.trim() || null,
      input.season?.trim() || null,
    ],
  );
}
