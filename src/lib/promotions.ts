/**
 * Phase 27 Wave 6 — the promotion engine (pure, framework-free).
 *
 * One engine, two callers: `order-totals.ts` (F&B orders) and
 * `retail-invoice-service.ts` (retail invoices) both hand it a cart and the
 * business's active promotions, and get back the same per-line discounts the
 * same way — so a café happy hour and a retail ست هدیه are the same rules
 * producing the same answer. No second discount path.
 *
 * Determinism is explicit and load-bearing (this file decides money):
 * promotions are evaluated in priority order (higher first, ties broken by
 * id), an `exclusive` promotion claims its lines so lower-priority promotions
 * skip them, and a `stackable` one applies on top. Every per-line discount is
 * clamped so it can never exceed the line's gross.
 */

export type PromotionKind = "percent" | "amount" | "bundle_price" | "buy_x_get_y";
export type PromotionStacking = "exclusive" | "stackable";

export interface Promotion {
  id: string;
  kind: PromotionKind;
  /**
   * percent: the percent off (0-100). amount: fixed Rial off each line.
   * bundle_price: the set price of the whole bundle. buy_x_get_y: the set
   * price of `minQuantity` units.
   */
  value: number;
  /** buy_x_get_y only: the quantity that unlocks the set price. */
  minQuantity?: number | null;
  itemIds?: string[] | null;
  brandIds?: string[] | null;
  categoryIds?: string[] | null;
  /** ISO date (YYYY-MM-DD, Gregorian — the stored convention), inclusive. */
  activeFrom?: string | null;
  activeTo?: string | null;
  /** 0-6, JS Date.getDay() convention (0 = Sunday). Null = every day. */
  daysOfWeek?: number[] | null;
  /** "HH:MM" local time, inclusive lower bound. */
  timeFrom?: string | null;
  /** "HH:MM" local time, exclusive upper bound. */
  timeTo?: string | null;
  /** Higher applies first; ties break by id so the answer never depends on list order. */
  priority: number;
  stacking: PromotionStacking;
}

export interface PromotionItem {
  /** The item's own id — `items.id` for retail, `menu_item_id` for F&B. */
  id: string;
  brandId?: string | null;
  categoryId?: string | null;
  /** Line gross before any promotion, Rial (integer). */
  gross: number;
  quantity: number;
}

export interface AppliedPromotion {
  promotionId: string;
  itemIndex: number;
  amount: number;
}

export interface PromotionEvaluation {
  /** Per item (same order as the cart), the total Rial discount across all promotions. */
  lineDiscounts: number[];
  totalDiscount: number;
  applied: AppliedPromotion[];
}

function localTimeMinutes(now: Date): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** The shop's local calendar date (not UTC), so a date window flips on the local midnight. */
function localDateIso(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseHm(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Whether a promotion is live at `now`, outside of any cart. Date windows are inclusive; the time upper bound is exclusive. */
export function isPromotionActive(promotion: Promotion, now: Date): boolean {
  const today = localDateIso(now);
  if (promotion.activeFrom && today < promotion.activeFrom) return false;
  if (promotion.activeTo && today > promotion.activeTo) return false;
  if (promotion.daysOfWeek && promotion.daysOfWeek.length > 0 && !promotion.daysOfWeek.includes(now.getDay())) {
    return false;
  }
  const nowMinutes = localTimeMinutes(now);
  if (promotion.timeFrom) {
    const from = parseHm(promotion.timeFrom);
    if (from === null) return false;
    if (nowMinutes < from) return false;
  }
  if (promotion.timeTo) {
    const to = parseHm(promotion.timeTo);
    if (to === null) return false;
    if (nowMinutes >= to) return false;
  }
  return true;
}

function matchesScope(promotion: Promotion, item: PromotionItem): boolean {
  if (promotion.itemIds && promotion.itemIds.length > 0 && !promotion.itemIds.includes(item.id)) return false;
  if (promotion.brandIds && promotion.brandIds.length > 0 && !(item.brandId && promotion.brandIds.includes(item.brandId))) {
    return false;
  }
  if (
    promotion.categoryIds &&
    promotion.categoryIds.length > 0 &&
    !(item.categoryId && promotion.categoryIds.includes(item.categoryId))
  ) {
    return false;
  }
  return true;
}

/** Split an integer amount across lines proportionally to their gross; the last line absorbs the rounding remainder so the parts sum exactly. */
function splitAcross(amount: number, grosses: number[]): number[] {
  const total = grosses.reduce((a, b) => a + b, 0);
  if (total <= 0 || amount <= 0) return grosses.map(() => 0);
  const parts: number[] = [];
  let allocated = 0;
  grosses.forEach((gross, i) => {
    const isLast = i === grosses.length - 1;
    const part = isLast ? amount - allocated : Math.round((amount * gross) / total);
    parts.push(part);
    allocated += part;
  });
  return parts;
}

/**
 * Evaluate a cart against the business's promotions at `now`.
 *
 * The per-line result is the sum of every promotion that touched the line,
 * and it is always clamped to that line's gross. Exclusive promotions claim
 * their lines first (by priority), so overlap resolves deterministically and
 * the result never depends on the order the promotions happened to be listed.
 */
export function evaluatePromotions(
  items: PromotionItem[],
  promotions: Promotion[],
  now: Date,
): PromotionEvaluation {
  const lineDiscounts = items.map(() => 0);
  const applied: AppliedPromotion[] = [];
  const claimed = items.map(() => false);

  const ordered = [...promotions].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  for (const promotion of ordered) {
    if (!isPromotionActive(promotion, now)) continue;

    const matching = items
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => matchesScope(promotion, item));

    if (matching.length === 0) continue;

    const available = matching.filter(({ i }) => !claimed[i]);

    if (promotion.kind === "percent") {
      for (const { item, i } of available) {
        const amount = Math.round((item.gross * Math.max(0, Math.min(promotion.value, 100))) / 100);
        applyDiscount(lineDiscounts, applied, claimed, promotion, i, amount, item.gross);
      }
      continue;
    }

    if (promotion.kind === "amount") {
      for (const { item, i } of available) {
        const amount = Math.min(Math.max(0, Math.round(promotion.value)), item.gross);
        applyDiscount(lineDiscounts, applied, claimed, promotion, i, amount, item.gross);
      }
      continue;
    }

    if (promotion.kind === "bundle_price") {
      // A bundle fires only when every member is present in the cart.
      const members = promotion.itemIds ?? [];
      if (members.length === 0) continue;
      const present = members.every((id) => items.some((item) => item.id === id));
      if (!present) continue;
      const bundleGross = available.reduce((sum, { item }) => sum + item.gross, 0);
      const amount = Math.max(0, bundleGross - Math.round(promotion.value));
      const parts = splitAcross(amount, available.map(({ item }) => item.gross));
      available.forEach(({ item, i }, idx) => {
        applyDiscount(lineDiscounts, applied, claimed, promotion, i, parts[idx], item.gross);
      });
      continue;
    }

    if (promotion.kind === "buy_x_get_y") {
      const minQty = promotion.minQuantity ?? 0;
      if (minQty <= 0) continue;
      const totalQty = available.reduce((sum, { item }) => sum + item.quantity, 0);
      if (totalQty < minQty) continue;
      const bundleGross = available.reduce((sum, { item }) => sum + item.gross, 0);
      const amount = Math.max(0, bundleGross - Math.round(promotion.value));
      const parts = splitAcross(amount, available.map(({ item }) => item.gross));
      available.forEach(({ item, i }, idx) => {
        applyDiscount(lineDiscounts, applied, claimed, promotion, i, parts[idx], item.gross);
      });
      continue;
    }
  }

  return {
    lineDiscounts,
    totalDiscount: lineDiscounts.reduce((a, b) => a + b, 0),
    applied,
  };
}

function applyDiscount(
  lineDiscounts: number[],
  applied: AppliedPromotion[],
  claimed: boolean[],
  promotion: Promotion,
  itemIndex: number,
  amount: number,
  gross: number,
): void {
  const remaining = Math.max(0, gross - lineDiscounts[itemIndex]);
  const actual = Math.min(amount, remaining);
  if (actual <= 0) return;
  lineDiscounts[itemIndex] += actual;
  applied.push({ promotionId: promotion.id, itemIndex, amount: actual });
  if (promotion.stacking === "exclusive") claimed[itemIndex] = true;
}
