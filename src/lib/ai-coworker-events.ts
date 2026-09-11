/**
 * Phase 32 — enqueuing a business event for the coworker.
 *
 * Its own module, and a deliberately tiny one: `shift-service` and
 * `business-day-service` are the producers, and importing the full
 * `ai-coworker-service` from them would close an import cycle
 * (business-day-service → ai-coworker-service → ai-autopilot-service →
 * ai-tools → business-day-service). Nothing here imports anything but `db`.
 */
import { query } from "./db";
import type { CoworkerEventKind } from "./ai-coworker";

/**
 * Records that something happened which a coworker job may be waiting for. The
 * tick is what acts on it.
 *
 * Deliberately swallows its own errors: this is called from the middle of a
 * cashier clocking out, and a coworker job that cannot be queued must never be
 * the reason a shift fails to close.
 */
export async function recordCoworkerEvent(input: {
  businessId: string;
  locationId: string | null;
  kind: CoworkerEventKind;
  payload?: Record<string, unknown>;
  /** Stable source identity for lifecycle events; null preserves older event producers. */
  dedupeKey?: string;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO ai_coworker_events (business_id, location_id, kind, business_date, payload, dedupe_key)
       SELECT $1, $2, $3,
              CASE WHEN l.id IS NULL THEN NULL
                   ELSE app_business_date(now(), l.timezone, l.business_day_start_minutes) END,
              $4::jsonb, $5
         FROM (SELECT 1) AS one
         LEFT JOIN locations l ON l.id = $2::uuid
       ON CONFLICT (business_id, kind, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [input.businessId, input.locationId, input.kind, JSON.stringify(input.payload ?? {}), input.dedupeKey ?? null],
    );
  } catch (error) {
    console.error("coworker event enqueue failed:", error instanceof Error ? error.message : error);
  }
}
