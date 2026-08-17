/**
 * Phase 27 Wave 6 — promotions and gift cards (DB-touching).
 *
 * `promotions` rows are the source of truth the pure engine
 * (promotions.ts) evaluates; this file reads them into the engine's shape and
 * writes them. Gift-card value is a liability reconstructed from the domain
 * events that posted it (issue credits 2420, redeem debits it) — the same
 * never-a-column discipline store credit and consignment use.
 */
import type { PoolClient } from "pg";
import { getPool, query } from "./db";
import { rialText } from "./inventory-exact";
import { emitDomainEvent } from "./posting-engine";
import { promotionEffectiveness } from "./industry-reports";
import type { Promotion } from "./promotions";
// Side-effect import: registers the gift-card posting rules.
import "./promotions-posting-rules";

export interface PromotionInput {
  id?: string;
  name: string;
  kind: Promotion["kind"];
  value: number;
  minQuantity?: number | null;
  itemIds?: string[];
  brandIds?: string[];
  categoryIds?: string[];
  activeFrom?: string | null;
  activeTo?: string | null;
  daysOfWeek?: number[];
  timeFrom?: string | null;
  timeTo?: string | null;
  priority?: number;
  stacking?: Promotion["stacking"];
  isActive?: boolean;
}

interface PromotionRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  name: string;
  kind: Promotion["kind"];
  value: string;
  min_quantity: number | null;
  item_ids: string[] | null;
  brand_ids: string[] | null;
  category_ids: string[] | null;
  active_from: string | null;
  active_to: string | null;
  days_of_week: number[] | null;
  time_from: string | null;
  time_to: string | null;
  priority: number;
  stacking: Promotion["stacking"];
  is_active: boolean;
}

function mapPromotion(row: PromotionRow): Promotion {
  const toHm = (value: string | null) => (value ? value.slice(0, 5) : null);
  return {
    id: row.id,
    kind: row.kind,
    value: Number(row.value),
    minQuantity: row.min_quantity,
    itemIds: row.item_ids?.length ? row.item_ids : null,
    brandIds: row.brand_ids?.length ? row.brand_ids : null,
    categoryIds: row.category_ids?.length ? row.category_ids : null,
    activeFrom: row.active_from,
    activeTo: row.active_to,
    daysOfWeek: row.days_of_week?.length ? row.days_of_week : null,
    timeFrom: toHm(row.time_from),
    timeTo: toHm(row.time_to),
    priority: row.priority,
    stacking: row.stacking,
  };
}

export async function listPromotions(businessId: string, includeInactive = false, client?: PoolClient): Promise<Promotion[]> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<PromotionRow>(
    `SELECT * FROM promotions WHERE business_id = $1 ${includeInactive ? "" : "AND is_active"} ORDER BY priority DESC, name`,
    [businessId],
  );
  return rows.map(mapPromotion);
}

export async function upsertPromotion(businessId: string, input: PromotionInput): Promise<Promotion> {
  const name = input.name?.trim();
  if (!name) throw new Error("نام کمپین نمی‌تواند خالی باشد.");
  if (!["percent", "amount", "bundle_price", "buy_x_get_y"].includes(input.kind)) {
    throw new Error("نوع کمپین نامعتبر است.");
  }
  if (!Number.isInteger(input.value) || input.value < 0) {
    throw new Error("مقدار کمپین باید یک عدد صحیح غیرمنفی باشد.");
  }

  const { rows } = await query<PromotionRow>(
    `INSERT INTO promotions
       (id, business_id, name, kind, value, min_quantity, item_ids, brand_ids, category_ids,
        active_from, active_to, days_of_week, time_from, time_to, priority, stacking, is_active)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12, $13::time, $14::time, $15, $16, $17)
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, kind = EXCLUDED.kind, value = EXCLUDED.value, min_quantity = EXCLUDED.min_quantity,
           item_ids = EXCLUDED.item_ids, brand_ids = EXCLUDED.brand_ids, category_ids = EXCLUDED.category_ids,
           active_from = EXCLUDED.active_from, active_to = EXCLUDED.active_to,
           days_of_week = EXCLUDED.days_of_week, time_from = EXCLUDED.time_from, time_to = EXCLUDED.time_to,
           priority = EXCLUDED.priority, stacking = EXCLUDED.stacking, is_active = EXCLUDED.is_active
     RETURNING *`,
    [
      input.id ?? null,
      businessId,
      name,
      input.kind,
      input.value,
      input.minQuantity ?? null,
      input.itemIds ?? [],
      input.brandIds ?? [],
      input.categoryIds ?? [],
      input.activeFrom ?? null,
      input.activeTo ?? null,
      input.daysOfWeek ?? [],
      input.timeFrom ?? null,
      input.timeTo ?? null,
      input.priority ?? 0,
      input.stacking ?? "exclusive",
      input.isActive ?? true,
    ],
  );
  return mapPromotion(rows[0]);
}

export interface GiftCard {
  id: string;
  businessId: string;
  code: string;
  initialValue: number;
  isActive: boolean;
  createdAt: string;
}

interface GiftCardRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  code: string;
  initial_value: string;
  is_active: boolean;
  created_at: string;
}

function mapGiftCard(row: GiftCardRow): GiftCard {
  return {
    id: row.id,
    businessId: row.business_id,
    code: row.code,
    initialValue: Number(row.initial_value),
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export async function getGiftCardByCode(businessId: string, code: string, client?: PoolClient): Promise<GiftCard | null> {
  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<GiftCardRow>(
    `SELECT * FROM gift_cards WHERE business_id = $1 AND code = $2`,
    [businessId, code.trim()],
  );
  return rows[0] ? mapGiftCard(rows[0]) : null;
}

/** The card's outstanding value, reconstructed from its issued/redeemed events — never a stored column. */
export async function giftCardBalance(businessId: string, code: string, client?: PoolClient): Promise<number> {
  const card = await getGiftCardByCode(businessId, code, client);
  if (!card) return 0;

  const run = <T extends Record<string, unknown>>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params as never) : query<T>(text, params);
  const { rows } = await run<{ issued: string | null; redeemed: string | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN event_type = 'promotions.gift_card_issued'
                          THEN (payload->>'amount')::bigint ELSE 0 END), 0)::text AS issued,
       COALESCE(SUM(CASE WHEN event_type = 'promotions.gift_card_redeemed'
                          THEN (payload->>'amount')::bigint ELSE 0 END), 0)::text AS redeemed
       FROM domain_events
      WHERE business_id = $1 AND payload->>'giftCardId' = $2`,
    [businessId, card.id],
  );
  return Number(rows[0]?.issued ?? 0) - Number(rows[0]?.redeemed ?? 0);
}

export async function issueGiftCard(
  client: PoolClient,
  input: { businessId: string; locationId: string; code: string; initialValue: number; createdBy?: string | null },
): Promise<{ card: GiftCard; entryId: string | null }> {
  const code = input.code?.trim();
  if (!code) throw new Error("کد کارت هدیه نمی‌تواند خالی باشد.");
  if (!Number.isInteger(input.initialValue) || input.initialValue <= 0) {
    throw new Error("ارزش اولیه کارت هدیه باید یک عدد صحیح مثبت (ریال) باشد.");
  }

  const { rows } = await client.query<GiftCardRow>(
    `INSERT INTO gift_cards (business_id, code, initial_value) VALUES ($1, $2, $3) RETURNING *`,
    [input.businessId, code, input.initialValue],
  );
  const card = mapGiftCard(rows[0]);

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "promotions.gift_card_issued",
    payload: { giftCardId: card.id, amount: rialText(String(input.initialValue)) },
    sourceType: "gift_card",
    sourceId: card.id,
    createdBy: input.createdBy ?? null,
  });

  return { card, entryId };
}

export async function redeemGiftCard(
  client: PoolClient,
  input: { businessId: string; locationId: string; code: string; amount: number; createdBy?: string | null },
): Promise<{ balance: number; entryId: string | null }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new Error("مبلغ مصرف کارت هدیه باید یک عدد صحیح مثبت (ریال) باشد.");
  }
  const card = await getGiftCardByCode(input.businessId, input.code, client);
  if (!card || !card.isActive) throw new Error("کارت هدیه یافت نشد.");

  const balance = await giftCardBalance(input.businessId, input.code, client);
  if (input.amount > balance) throw new Error("اعتبار کارت هدیه کافی نیست.");

  const { entryId } = await emitDomainEvent(client, {
    businessId: input.businessId,
    locationId: input.locationId,
    eventType: "promotions.gift_card_redeemed",
    payload: { giftCardId: card.id, amount: rialText(String(input.amount)) },
    sourceType: "gift_card",
    sourceId: card.id,
    createdBy: input.createdBy ?? null,
  });

  return { balance: balance - input.amount, entryId };
}

/**
 * Phase 27 Wave 13 — the promotion effectiveness report: each campaign's
 * application count and total discount over a window, joined to its name so
 * the report reads as a ranking rather than a list of ids.
 */
export async function promotionEffectivenessReport(
  businessId: string,
  range: { from?: string | null; to?: string | null },
): Promise<{
  rows: Array<{ promotionId: string; promotionName: string; applications: number; totalDiscountRial: number }>;
  totalApplications: number;
  totalDiscountRial: number;
}> {
  const { rows } = await query<{ promotion_id: string; discount_rial: string }>(
    `SELECT promotion_id, discount_rial
       FROM promotion_applications
      WHERE business_id = $1
        AND ($2::date IS NULL OR created_at::date >= $2::date)
        AND ($3::date IS NULL OR created_at::date <= $3::date)`,
    [businessId, range.from ?? null, range.to ?? null],
  );
  const effect = promotionEffectiveness(
    rows.map((r) => ({ promotionId: r.promotion_id, discountRial: Number(r.discount_rial) })),
  );

  const names = new Map<string, string>();
  if (effect.rows.length > 0) {
    const { rows: promoRows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM promotions WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [businessId, effect.rows.map((r) => r.promotionId)],
    );
    for (const row of promoRows) names.set(row.id, row.name);
  }

  return {
    rows: effect.rows.map((r) => ({
      promotionId: r.promotionId,
      promotionName: names.get(r.promotionId) ?? r.promotionId,
      applications: r.applications,
      totalDiscountRial: r.totalDiscountRial,
    })),
    totalApplications: effect.totalApplications,
    totalDiscountRial: effect.totalDiscountRial,
  };
}
