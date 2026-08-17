/**
 * Back-dated orders — the framework-free half.
 *
 * A back-dated order is an ordinary sale whose `occurredAt` is in the past:
 * the day the POS was down and the bills were written on paper, or the trading
 * that happened before this system was installed. The DB-touching orchestration
 * lives in backdated-order-service.ts; what lives here is the part that is pure
 * and therefore directly testable — validating the instant, the reason, and the
 * cart, and turning an instant into the branch's business date.
 *
 * The two rules that matter are both about the instant:
 *
 *   * it may not be in the future. A "sale" dated next Tuesday is either a typo
 *     or an attempt to move revenue into a period that has not happened; either
 *     way the till is not the place to allow it. A small tolerance absorbs
 *     clock skew between the browser that picked the time and the server that
 *     stores it, and nothing more.
 *   * it may not be arbitrarily old. Not because an old sale is invalid, but
 *     because the further back it goes the more it disagrees with stock that
 *     has since been counted and periods that have since been closed — and a
 *     mistyped Jalali year is the most likely way to land there. The window is
 *     generous (a year) and the fiscal-period lock still refuses anything
 *     inside a closed month regardless.
 */

/** How far ahead of the server's clock a caller's instant may be, in ms — clock skew, not a grace period. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/** How far back a back-dated sale may reach, in days. See the module comment. */
export const MAX_BACKDATE_DAYS = 366;

export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;

/** Same ceiling the open-order item routes and amendments enforce. */
export const MAX_LINE_QUANTITY = 50;

export const BACKDATED_ORDER_TYPES = ["dine_in", "takeaway", "delivery"] as const;
export type BackdatedOrderType = (typeof BACKDATED_ORDER_TYPES)[number];

export interface BackdatedTenderInput {
  methodId?: string | null;
  method?: string | null;
  amount?: number | null;
  reference?: string | null;
}

export interface BackdatedLineInput {
  menuItemId?: string | null;
  quantity?: number | null;
  note?: string | null;
  modifierIds?: string[] | null;
}

export interface BackdatedOrderInput {
  /**
   * ISO-8601 instant the sale actually happened, with an explicit offset. The
   * precise form, for an API caller that has one.
   */
  occurredAt?: string | null;
  /**
   * The screen's form instead: the day (ISO, from the Jalali picker) and the
   * wall-clock time, both read in the *branch's* zone. See instantInTimeZone.
   */
  occurredOn?: string | null;
  occurredTime?: string | null;
  type?: string | null;
  reason?: string | null;
  note?: string | null;
  customerId?: string | null;
  lines?: BackdatedLineInput[] | null;
  discount?: { type?: "percent" | "amount" | null; value?: number | null } | null;
  tipAmount?: number | null;
  payments?: BackdatedTenderInput[] | null;
}

export interface ValidatedBackdatedOrder {
  occurredAt: Date;
  type: BackdatedOrderType;
  reason: string;
  note: string | null;
  customerId: string | null;
  lines: { menuItemId: string; quantity: number; note: string | null; modifierIds: string[] }[];
  discount: { type: "percent" | "amount" | null; value: number };
  tipAmount: number;
  payments: BackdatedTenderInput[];
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The branch's business date for an instant — the TypeScript twin of SQL's
 * `app_business_date(ts, tz, start_minutes)` (migration 0076), returning
 * `YYYY-MM-DD`.
 *
 * The service could ask Postgres for this instead, and for the *stored*
 * entry_date it effectively does. This exists so a caller can be told which day
 * a sale will land on before it commits to it — the screen shows «این فروش روی
 * روز کاری ۱۴۰۵/۰۵/۲۶ ثبت می‌شود» — without a round trip, and so the rule can be
 * unit-tested against the same fixtures the SQL was written for.
 *
 * `startMinutes` NULL means the branch has no business day configured, which is
 * the calendar day in its own zone — exactly what the SQL function returns for
 * it.
 */
export function businessDateOf(instant: Date, timezone: string, startMinutes: number | null): string {
  const shifted = new Date(instant.getTime() - (startMinutes ?? 0) * 60_000);
  // `en-CA` renders as YYYY-MM-DD, and the timeZone option does the
  // `AT TIME ZONE` half. Intl is the only zone database in the runtime, so
  // this is also the only way to agree with Postgres without asking it.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(shifted);
}

/**
 * The offset, in ms, that `timeZone` was running at a given instant — the
 * amount its wall clock is ahead of UTC.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || "UTC",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // `hour` can render as 24 for midnight under hour12:false in some engines.
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asIfUtc - at.getTime();
}

/**
 * The instant at which `timeZone`'s wall clock read `dateIso` at `time` — the
 * inverse of businessDateOf, and what turns «۲۶ مرداد، ساعت ۲۱:۳۰» into a
 * timestamptz.
 *
 * The branch's own zone is what resolves it, never the browser's: a till whose
 * clock is set to the wrong country must not be able to move a sale by hours,
 * and for a branch with a business day it could move it by a whole trading day.
 *
 * Two passes, because the offset is itself a function of the instant: the first
 * guess uses the offset in force at the naive time, the second corrects it if
 * that guess landed on the other side of a DST transition. (Iran has had no DST
 * since 1401/2022, so in practice the second pass changes nothing here — it is
 * for the branches this app will be installed in that do.)
 */
export function instantInTimeZone(dateIso: string, time: string, timeZone: string): Date | null {
  if (!ISO_DATE_RE.test(dateIso) || !CLOCK_TIME_RE.test(time)) return null;
  const [year, month, day] = dateIso.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59) return null;

  const naive = Date.UTC(year, month - 1, day, hours, minutes);
  const firstPass = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  const resolved = new Date(naive - zoneOffsetMs(firstPass, timeZone));
  if (Number.isNaN(resolved.getTime())) return null;
  // A date that does not exist (31 Farvardin has 31 days, 31 Esfand does not)
  // silently rolls forward through Date.UTC; reject it rather than record a
  // sale on a day the calendar never had.
  if (businessDateOf(resolved, timeZone, null) !== dateIso) return null;
  return resolved;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_TIME_RE = /^\d{2}:\d{2}$/;

/**
 * ISO-8601 date-time with an explicit offset (or `Z`). The offset is required
 * rather than optional: an instant with none is read in the *server's* zone,
 * which would silently shift a sale by hours — and by a whole trading day for
 * anything near the branch's business-day boundary.
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO instant, rejecting anything `Date` would otherwise coerce.
 * `new Date("1405/05/26")` is a valid date in the year 1405 — a Jalali string
 * pasted into an ISO field must fail here rather than be recorded as a sale
 * from the fifteenth century.
 */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!ISO_INSTANT_RE.test(text)) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function validateBackdatedOrder(
  input: BackdatedOrderInput,
  options: { now?: Date; timeZone?: string } = {},
): Validated<ValidatedBackdatedOrder> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone || "Asia/Tehran";

  // A day-and-time pair is resolved in the branch's zone; a full instant is
  // taken as given. One of the two must be there.
  const occurredAt = input.occurredAt
    ? parseInstant(input.occurredAt)
    : instantInTimeZone(input.occurredOn?.trim() ?? "", input.occurredTime?.trim() ?? "", timeZone);
  if (!occurredAt) return { ok: false, error: "invalid_occurred_at" };
  if (occurredAt.getTime() > now.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
    return { ok: false, error: "occurred_at_in_future" };
  }
  if (occurredAt.getTime() < now.getTime() - MAX_BACKDATE_DAYS * 86_400_000) {
    return { ok: false, error: "occurred_at_too_old" };
  }

  const type = input.type as BackdatedOrderType;
  if (!BACKDATED_ORDER_TYPES.includes(type)) return { ok: false, error: "invalid_order_type" };

  const reason = (input.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) {
    return { ok: false, error: "invalid_reason" };
  }

  const rawLines = input.lines ?? [];
  if (rawLines.length === 0) return { ok: false, error: "no_items" };
  const lines: ValidatedBackdatedOrder["lines"] = [];
  for (const line of rawLines) {
    const menuItemId = line?.menuItemId?.trim();
    if (!menuItemId) return { ok: false, error: "invalid_item" };
    const quantity = Number(line?.quantity ?? 0);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
      return { ok: false, error: "invalid_quantity" };
    }
    const modifierIds = line?.modifierIds ?? [];
    if (!Array.isArray(modifierIds) || modifierIds.some((id) => typeof id !== "string" || !id.trim())) {
      return { ok: false, error: "invalid_modifier" };
    }
    lines.push({
      menuItemId,
      quantity,
      note: line?.note?.trim() || null,
      modifierIds: modifierIds.map((id) => id.trim()),
    });
  }

  const discountType =
    input.discount?.type === "percent" || input.discount?.type === "amount" ? input.discount.type : null;
  const discountValue = Number(input.discount?.value ?? 0);
  if (
    discountType &&
    (!Number.isFinite(discountValue) ||
      discountValue < 0 ||
      (discountType === "percent" && discountValue > 100))
  ) {
    return { ok: false, error: "invalid_discount" };
  }

  const tipAmount = Number(input.tipAmount ?? 0);
  if (!Number.isSafeInteger(tipAmount) || tipAmount < 0) return { ok: false, error: "invalid_tip_amount" };

  const payments = input.payments ?? [];
  if (payments.length === 0) return { ok: false, error: "no_payment" };

  return {
    ok: true,
    value: {
      occurredAt,
      type,
      reason,
      note: input.note?.trim() || null,
      customerId: input.customerId?.trim() || null,
      lines,
      discount: { type: discountType, value: discountType ? discountValue : 0 },
      tipAmount,
      payments,
    },
  };
}
