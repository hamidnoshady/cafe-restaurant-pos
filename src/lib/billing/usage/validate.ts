import { meterByKey } from "../catalog/meters";

export type UsageRejectCode =
  | "UNKNOWN_METER"
  | "INVALID_UNIT"
  | "INVALID_QUANTITY"
  | "INVALID_EVENT"
  | "INVALID_PERIOD";

export interface UsageEventInput {
  eventId: string;
  meterKey: string;
  quantity: number;
  unit: string;
  eventKind?: "usage" | "correction";
  periodStart?: string | null;
  periodEnd?: string | null;
}

/**
 * Reject an event the ledger must not store. Corrections may be negative;
 * ordinary usage must be a positive integer in the meter's unit.
 */
export function validateUsageEvent(input: UsageEventInput): { ok: true } | { ok: false; code: UsageRejectCode } {
  if (!input.eventId || input.eventId.length > 200) return { ok: false, code: "INVALID_EVENT" };
  const meter = meterByKey(input.meterKey);
  if (!meter || !meter.active) return { ok: false, code: "UNKNOWN_METER" };
  if (input.unit !== meter.unit) return { ok: false, code: "INVALID_UNIT" };
  const kind = input.eventKind ?? "usage";
  if (!Number.isSafeInteger(input.quantity)) return { ok: false, code: "INVALID_QUANTITY" };
  if (kind === "usage" && input.quantity <= 0) return { ok: false, code: "INVALID_QUANTITY" };
  if (kind === "correction" && input.quantity === 0) return { ok: false, code: "INVALID_QUANTITY" };
  if (input.periodStart && input.periodEnd && input.periodStart > input.periodEnd) {
    return { ok: false, code: "INVALID_PERIOD" };
  }
  return { ok: true };
}
