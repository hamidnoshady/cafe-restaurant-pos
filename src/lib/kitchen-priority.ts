/**
 * Phase 18b Wave 3 — deterministic kitchen queue priority.
 *
 * The schema currently has no promised-ready time or per-item prep duration,
 * so an LLM would have nothing reliable to improve here. This ranking is
 * deliberately transparent: overdue tickets first; then unstarted tickets;
 * then in-progress tickets; then ready-for-service tickets. Within a tier,
 * the oldest ticket wins.
 */
import { DEFAULT_TICKET_AGING_MINUTES, ticketAgeMinutes } from "./order-item-status";

export type KitchenQueueStatus = "sent" | "preparing" | "ready";
export type KitchenPriorityTier = "overdue" | "waiting" | "preparing" | "ready";

export interface KitchenTicketPriority {
  tier: KitchenPriorityTier;
  isLate: boolean;
  ageMinutes: number;
  /** Stable score for tier ordering; use compareKitchenTicketPriority for ties. */
  sortScore: number;
  /** Normalized timestamp for deterministic oldest-first tie breaking. */
  sentAtMs: number;
}

export interface KitchenQueueEntry {
  status: KitchenQueueStatus;
  sent_to_kitchen_at: string | number | Date;
}

const STATUS_SCORE: Record<KitchenQueueStatus, number> = {
  sent: 2,
  preparing: 1,
  ready: 0,
};

function toEpoch(value: string | number | Date, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Scores one ticket without any model call. The optional inputs make it easy
 * to test the policy at a fixed clock and retain the existing aging threshold.
 */
export function priorityForKitchenTicket(
  input: { status: KitchenQueueStatus; sentAt: string | number | Date },
  nowMs: number = Date.now(),
  thresholdMinutes: number = DEFAULT_TICKET_AGING_MINUTES,
): KitchenTicketPriority {
  const safeNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const sentAtMs = toEpoch(input.sentAt, safeNow);
  const ageMinutes = ticketAgeMinutes(sentAtMs, safeNow);
  const isLate = ageMinutes >= thresholdMinutes;
  const tier: KitchenPriorityTier = isLate
    ? "overdue"
    : input.status === "sent"
      ? "waiting"
      : input.status;

  return {
    tier,
    isLate,
    ageMinutes,
    sortScore: (isLate ? 10 : 0) + STATUS_SCORE[input.status],
    sentAtMs,
  };
}

/** Higher priority first; within an equal tier, oldest sent time first. */
export function compareKitchenTicketPriority(
  left: KitchenTicketPriority,
  right: KitchenTicketPriority,
): number {
  if (left.sortScore !== right.sortScore) return right.sortScore - left.sortScore;
  return left.sentAtMs - right.sentAtMs;
}

/** Adds a priority shape to API queue rows and returns them in queue order. */
export function rankKitchenQueue<T extends KitchenQueueEntry>(
  rows: T[],
  nowMs: number = Date.now(),
): Array<T & { priority: KitchenTicketPriority }> {
  return rows
    .map((row) => ({
      ...row,
      priority: priorityForKitchenTicket(
        { status: row.status, sentAt: row.sent_to_kitchen_at },
        nowMs,
      ),
    }))
    .sort((left, right) =>
      compareKitchenTicketPriority(left.priority, right.priority),
    );
}
