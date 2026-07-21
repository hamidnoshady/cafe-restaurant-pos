/**
 * Phase 9 — multi-location rollup: the framework-free half.
 *
 * A "central" server is another deployment of this same app; each location's
 * local server periodically POSTs a `RollupPushPayload` (pre-aggregated daily
 * summaries, integer Rial) to the central `/api/rollup/ingest`, authenticated
 * with a per-location bearer token. This module holds everything about that
 * exchange that doesn't touch the database: payload validation, token
 * generation/hashing, the resend-window computation, and staleness.
 *
 * Pushes are idempotent by construction — a day is upserted wholesale keyed
 * on (location, business day) — so "catch up after being offline" is just
 * "push the window again"; there is no per-event queue between servers.
 */
import { createHash, randomBytes } from "node:crypto";

/** How often a location tries to push to central while online (ms). */
export const ROLLUP_SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** Re-push this many days before the last confirmed day, in case late orders/entries landed on it. */
export const RESEND_OVERLAP_DAYS = 2;
/** Central marks a location's data stale when it hasn't pushed for this long. */
export const STALE_AFTER_HOURS = 24;
/** Hard bounds on a single push, so a bad client can't flood ingest. */
export const MAX_DAYS_PER_PUSH = 800;
export const MAX_STAFF_PER_DAY = 200;

export interface RollupStaffDay {
  /** users.id in the location's own local DB (stable across pushes, not an FK centrally) */
  staffId: string;
  staffName: string;
  role: string | null;
  orderCount: number;
  revenue: number;
}

export interface RollupDay {
  /** YYYY-MM-DD in the location's own timezone (same bucketing as the local reporting views) */
  businessDay: string;
  orderCount: number;
  subtotal: number;
  discount: number;
  serviceCharge: number;
  tax: number;
  total: number;
  cashTotal: number;
  cardTotal: number;
  onlineTotal: number;
  creditTotal: number;
  cogs: number;
  wasteCost: number;
  staff: RollupStaffDay[];
}

export interface RollupPushPayload {
  location: {
    /** locations.id in the pushing server's own DB — informational on the central side */
    id: string;
    name: string;
    timezone: string;
  };
  days: RollupDay[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** New per-location bearer token. Shown once at registration; only its hash is stored. */
export function generateRollupToken(): string {
  return `rlk_${randomBytes(24).toString("hex")}`;
}

export function hashRollupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isValidBusinessDay(day: unknown): day is string {
  if (typeof day !== "string" || !DAY_RE.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

/** Money fields may be negative (refunds); counts may not. Everything must be a safe integer. */
function isMoney(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}
function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

const DAY_MONEY_FIELDS = [
  "subtotal",
  "discount",
  "serviceCharge",
  "tax",
  "total",
  "cashTotal",
  "cardTotal",
  "onlineTotal",
  "creditTotal",
  "cogs",
  "wasteCost",
] as const;

export type RollupValidation =
  | { ok: true; payload: RollupPushPayload }
  | { ok: false; error: string };

/** Structural validation for the ingest route. Never trusts the sender — it's a cross-server call. */
export function validateRollupPayload(body: unknown): RollupValidation {
  if (typeof body !== "object" || body === null) return { ok: false, error: "not_an_object" };
  const b = body as Record<string, unknown>;

  const loc = b.location as Record<string, unknown> | undefined;
  if (typeof loc !== "object" || loc === null) return { ok: false, error: "missing_location" };
  if (typeof loc.id !== "string" || !UUID_RE.test(loc.id)) {
    return { ok: false, error: "invalid_location_id" };
  }
  if (typeof loc.name !== "string" || !loc.name.trim()) {
    return { ok: false, error: "invalid_location_name" };
  }
  if (typeof loc.timezone !== "string" || !loc.timezone.trim()) {
    return { ok: false, error: "invalid_location_timezone" };
  }

  if (!Array.isArray(b.days)) return { ok: false, error: "missing_days" };
  if (b.days.length > MAX_DAYS_PER_PUSH) return { ok: false, error: "too_many_days" };

  const seenDays = new Set<string>();
  for (const rawDay of b.days) {
    if (typeof rawDay !== "object" || rawDay === null) return { ok: false, error: "invalid_day" };
    const d = rawDay as Record<string, unknown>;
    if (!isValidBusinessDay(d.businessDay)) return { ok: false, error: "invalid_business_day" };
    if (seenDays.has(d.businessDay)) return { ok: false, error: "duplicate_business_day" };
    seenDays.add(d.businessDay);
    if (!isCount(d.orderCount)) return { ok: false, error: "invalid_order_count" };
    for (const field of DAY_MONEY_FIELDS) {
      if (!isMoney(d[field])) return { ok: false, error: `invalid_${field}` };
    }
    if (!Array.isArray(d.staff)) return { ok: false, error: "missing_staff" };
    if (d.staff.length > MAX_STAFF_PER_DAY) return { ok: false, error: "too_many_staff" };
    const seenStaff = new Set<string>();
    for (const rawStaff of d.staff) {
      if (typeof rawStaff !== "object" || rawStaff === null) {
        return { ok: false, error: "invalid_staff_row" };
      }
      const s = rawStaff as Record<string, unknown>;
      if (typeof s.staffId !== "string" || !UUID_RE.test(s.staffId)) {
        return { ok: false, error: "invalid_staff_id" };
      }
      if (seenStaff.has(s.staffId)) return { ok: false, error: "duplicate_staff_id" };
      seenStaff.add(s.staffId);
      if (typeof s.staffName !== "string" || !s.staffName.trim()) {
        return { ok: false, error: "invalid_staff_name" };
      }
      if (s.role !== null && s.role !== undefined && typeof s.role !== "string") {
        return { ok: false, error: "invalid_staff_role" };
      }
      if (!isCount(s.orderCount)) return { ok: false, error: "invalid_staff_order_count" };
      if (!isMoney(s.revenue)) return { ok: false, error: "invalid_staff_revenue" };
    }
  }

  return { ok: true, payload: body as unknown as RollupPushPayload };
}

/** Pure YYYY-MM-DD arithmetic (UTC — business days are already tz-bucketed strings by now). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * First day (inclusive) the next push should cover. Never synced → null,
 * meaning "no lower bound, push everything" (day-level aggregates stay small
 * even over years). Otherwise back off RESEND_OVERLAP_DAYS before the last
 * confirmed day, so late-landing orders/journal entries on recent days
 * converge on the next push.
 */
export function computePushFromDay(lastSuccessDay: string | null): string | null {
  if (!lastSuccessDay || !isValidBusinessDay(lastSuccessDay)) return null;
  return addDays(lastSuccessDay, -RESEND_OVERLAP_DAYS);
}

/** Has a location gone quiet long enough that central should flag it? */
export function isSyncStale(
  lastSyncedAt: string | Date | null,
  now: Date = new Date(),
  staleAfterHours: number = STALE_AFTER_HOURS,
): boolean {
  if (!lastSyncedAt) return true;
  const t = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > staleAfterHours * 60 * 60 * 1000;
}
