/**
 * The customer file's timeline — a *mapping*, never a copy.
 *
 * Everything a customer has done with the business is already recorded
 * somewhere: `orders` and `order_items` hold the purchases, `payments` the
 * money, `customer_points` the loyalty ledger, `reservations` the bookings,
 * `repair_tickets` the watch/jewellery repairs, and this app's own tables hold
 * the notes, activities, deals, cases, consent changes and merges. What never
 * existed was one page showing them in order.
 *
 * The tempting implementation is an `events` table that every writer appends
 * to. It is the wrong one: a parallel event log is a second source of truth
 * that can fall behind the first, and it falls behind *silently*, because
 * nothing ever compares the two. Instead each source is read where it lives
 * and merged here. That costs a handful of indexed queries per file view and
 * buys a timeline that cannot be stale or wrong.
 *
 * Two conventions every row obeys, both from Phase 33:
 *
 * - **The Persian label comes from the tool, not the model.** Every event
 *   carries `kindLabel`, so an assistant answering about a customer never has
 *   to guess what `store_credit` means.
 * - **Money is three-shaped** (`{ rial, toman, text }`), so a caller never
 *   re-derives Toman or formats currency by hand.
 *
 * Industry-aware: a café has no repair rows, so the repair query is not even
 * issued for one. That is `hasCapability(industry, "repairs")` doing the same
 * job it does in the nav.
 */

import { query } from "./db";
import {
  labelFor,
  moneyFields,
  ORDER_STATUS_LABELS,
  RESERVATION_STATUS_LABELS,
} from "./ai-labels";
import { toPersianDigits } from "./digits";
import { getBusinessIndustry } from "./industry-guard";
import { hasCapability } from "./industry-profile";
import { REPAIR_STATUS_LABELS } from "./watch";
import {
  ACTIVITY_KIND_LABELS,
  CASE_STATUS_LABELS,
  CONSENT_CHANNEL_LABELS,
  CONSENT_SOURCE_LABELS,
  DEAL_STAGE_META,
  sortTimeline,
  TIMELINE_KIND_LABELS,
  type TimelineEvent,
} from "./crm-shared";

export interface TimelineOptions {
  /** Cap the merged result; each source is capped at this too, so one chatty source cannot crowd the rest out. */
  limit?: number;
  /** Restrict to certain kinds — the file's filter chips. */
  kinds?: readonly string[];
}

const DEFAULT_LIMIT = 100;

/**
 * Build one customer's timeline.
 *
 * Each source is queried independently and capped, then merged and sorted
 * newest-first. Capping *per source* rather than only at the end is deliberate:
 * a customer with 900 loyalty rows would otherwise push every order off the
 * page, and the page's job is to show the shape of the relationship.
 */
export async function customerTimeline(
  businessId: string,
  customerId: string,
  options: TimelineOptions = {},
): Promise<TimelineEvent[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const wanted = options.kinds ? new Set(options.kinds) : null;
  const want = (kind: string) => !wanted || wanted.has(kind);

  const industry = await getBusinessIndustry(businessId).catch(() => null);
  const hasRepairs = industry ? hasCapability(industry, "repairs") : false;

  const events: TimelineEvent[] = [];

  // -- Orders ---------------------------------------------------------------
  if (want("order")) {
    const { rows } = await query<{
      id: string;
      order_number: string;
      total: string;
      status: string;
      closed_at: string | null;
      opened_at: string;
      item_count: string;
    }>(
      `SELECT o.id, o.order_number::text, o.total::text, o.status::text,
              o.closed_at, o.opened_at,
              (SELECT count(*) FROM order_items oi
                WHERE oi.order_id = o.id AND oi.status <> 'voided')::text AS item_count
         FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE l.business_id = $1 AND o.customer_id = $2
        ORDER BY coalesce(o.closed_at, o.opened_at) DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      const total = Number(row.total);
      events.push({
        at: row.closed_at ?? row.opened_at,
        kind: "order",
        kindLabel: TIMELINE_KIND_LABELS.order,
        summary: `سفارش ${toPersianDigits(row.order_number)} — ${toPersianDigits(row.item_count)} قلم`,
        amount: moneyFields(total),
        href: `/accounting/orders/${row.id}`,
        detail:
          row.status === "completed"
            ? undefined
            : `وضعیت: ${labelFor(ORDER_STATUS_LABELS, row.status)}`,
      });
    }
  }

  // -- Payments -------------------------------------------------------------
  if (want("payment")) {
    const { rows } = await query<{
      amount: string;
      method: string;
      received_at: string;
      order_number: string | null;
    }>(
      `SELECT p.amount::text, p.method::text, p.received_at, o.order_number::text
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         JOIN locations l ON l.id = p.location_id
        WHERE l.business_id = $1 AND o.customer_id = $2
        ORDER BY p.received_at DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      const amount = Number(row.amount);
      events.push({
        at: row.received_at,
        kind: "payment",
        kindLabel: TIMELINE_KIND_LABELS.payment,
        // A negative payment is a refund — said in words rather than left as a
        // minus sign the reader has to notice.
        summary: amount < 0 ? `برگشت وجه (${row.method})` : `پرداخت (${row.method})`,
        amount: moneyFields(Math.abs(amount)),
      });
    }
  }

  // -- Loyalty points -------------------------------------------------------
  if (want("points")) {
    const { rows } = await query<{ points: number; source_type: string; created_at: string }>(
      `SELECT points, source_type, created_at
         FROM customer_points
        WHERE business_id = $1 AND customer_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      events.push({
        at: row.created_at,
        kind: "points",
        kindLabel: TIMELINE_KIND_LABELS.points,
        summary: row.points >= 0 ? `${row.points} امتیاز گرفت` : `${Math.abs(row.points)} امتیاز خرج کرد`,
        detail: row.source_type,
      });
    }
  }

  // -- Reservations ---------------------------------------------------------
  if (want("reservation")) {
    const { rows } = await query<{
      reserved_at: string;
      party_size: number;
      status: string;
      created_at: string;
    }>(
      `SELECT r.reserved_at, r.party_size, r.status::text, r.created_at
         FROM reservations r
         JOIN locations l ON l.id = r.location_id
        WHERE l.business_id = $1 AND r.customer_id = $2
        ORDER BY r.reserved_at DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      events.push({
        at: row.reserved_at,
        kind: "reservation",
        kindLabel: TIMELINE_KIND_LABELS.reservation,
        summary: `رزرو برای ${toPersianDigits(row.party_size)} نفر`,
        detail: `وضعیت: ${labelFor(RESERVATION_STATUS_LABELS, row.status)}`,
      });
    }
  }

  // -- Repairs (only where the trade has them) ------------------------------
  if (hasRepairs && want("repair")) {
    const { rows } = await query<{
      id: string;
      ticket_number: string;
      item_description: string;
      status: string;
      labor_charge: string;
      created_at: string;
    }>(
      `SELECT rt.id, rt.ticket_number::text, rt.item_description, rt.status,
              rt.labor_charge::text, rt.created_at
         FROM repair_tickets rt
         JOIN locations l ON l.id = rt.location_id
        WHERE l.business_id = $1 AND rt.customer_id = $2
        ORDER BY rt.created_at DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      events.push({
        at: row.created_at,
        kind: "repair",
        kindLabel: TIMELINE_KIND_LABELS.repair,
        summary: `تعمیر ${toPersianDigits(row.ticket_number)} — ${row.item_description}`,
        amount: moneyFields(Number(row.labor_charge)),
        detail: `وضعیت: ${labelFor(REPAIR_STATUS_LABELS, row.status)}`,
      });
    }
  }

  // -- Notes ----------------------------------------------------------------
  if (want("note")) {
    const { rows } = await query<{ body: string; created_by: string; created_at: string; is_pinned: boolean }>(
      `SELECT body, created_by, created_at, is_pinned
         FROM customer_notes
        WHERE business_id = $1 AND customer_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      events.push({
        at: row.created_at,
        kind: "note",
        kindLabel: TIMELINE_KIND_LABELS.note,
        summary: row.body,
        detail: row.created_by || undefined,
      });
    }
  }

  // -- Activities -----------------------------------------------------------
  if (want("activity")) {
    const { rows } = await query<{
      kind: string;
      subject: string;
      body: string;
      created_at: string;
      completed_at: string | null;
      due_at: string | null;
    }>(
      `SELECT kind, subject, body, created_at, completed_at, due_at
         FROM crm_activities
        WHERE business_id = $1 AND customer_id = $2
        ORDER BY coalesce(completed_at, due_at, created_at) DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      events.push({
        at: row.completed_at ?? row.created_at,
        kind: "activity",
        kindLabel: ACTIVITY_KIND_LABELS[row.kind as keyof typeof ACTIVITY_KIND_LABELS] ?? TIMELINE_KIND_LABELS.activity,
        summary: row.subject,
        detail: row.body || undefined,
      });
    }
  }

  // -- Deals ----------------------------------------------------------------
  if (want("deal")) {
    const { rows } = await query<{
      id: string;
      title: string;
      stage: string;
      value_rial: string;
      created_at: string;
      closed_at: string | null;
    }>(
      `SELECT id, title, stage, value_rial::text, created_at, closed_at
         FROM crm_deals
        WHERE business_id = $1 AND customer_id = $2
        ORDER BY coalesce(closed_at, created_at) DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      const meta = DEAL_STAGE_META[row.stage as keyof typeof DEAL_STAGE_META];
      events.push({
        at: row.closed_at ?? row.created_at,
        kind: "deal",
        kindLabel: TIMELINE_KIND_LABELS.deal,
        summary: row.title,
        // The value is what the owner expects to sell, not posted revenue —
        // said here so the file never reads as if the deal booked money.
        amount: moneyFields(Number(row.value_rial)),
        detail: `مرحله: ${meta?.label ?? row.stage} (مبلغ برآوردی)`,
        href: `/crm/deals?deal=${row.id}`,
      });
    }
  }

  // -- Cases ----------------------------------------------------------------
  if (want("case")) {
    const { rows } = await query<{
      id: string;
      subject: string;
      status: string;
      opened_at: string;
      resolved_at: string | null;
    }>(
      `SELECT id, subject, status, opened_at, resolved_at
         FROM crm_cases
        WHERE business_id = $1 AND customer_id = $2
        ORDER BY opened_at DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      events.push({
        at: row.resolved_at ?? row.opened_at,
        kind: "case",
        kindLabel: TIMELINE_KIND_LABELS.case,
        summary: row.subject,
        detail: `وضعیت: ${CASE_STATUS_LABELS[row.status as keyof typeof CASE_STATUS_LABELS] ?? row.status}`,
        href: `/crm/cases?case=${row.id}`,
      });
    }
  }

  // -- Consent changes ------------------------------------------------------
  if (want("consent")) {
    const { rows } = await query<{
      channel: string;
      granted: boolean;
      source: string;
      changed_by: string;
      created_at: string;
    }>(
      `SELECT channel, granted, source, changed_by, created_at
         FROM crm_consent_events
        WHERE business_id = $1 AND customer_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      const channel = CONSENT_CHANNEL_LABELS[row.channel as keyof typeof CONSENT_CHANNEL_LABELS] ?? row.channel;
      events.push({
        at: row.created_at,
        kind: "consent",
        kindLabel: TIMELINE_KIND_LABELS.consent,
        summary: row.granted ? `اجازهٔ ${channel} داده شد` : `اجازهٔ ${channel} لغو شد`,
        detail: `${CONSENT_SOURCE_LABELS[row.source as keyof typeof CONSENT_SOURCE_LABELS] ?? row.source}${
          row.changed_by ? ` — ${row.changed_by}` : ""
        }`,
      });
    }
  }

  // -- Merges ---------------------------------------------------------------
  if (want("merge")) {
    const { rows } = await query<{ created_at: string; merged_by: string; loser_snapshot: { name?: string } }>(
      `SELECT created_at, merged_by, loser_snapshot
         FROM crm_merges
        WHERE business_id = $1 AND winner_id = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [businessId, customerId, limit],
    );
    for (const row of rows) {
      events.push({
        at: row.created_at,
        kind: "merge",
        kindLabel: TIMELINE_KIND_LABELS.merge,
        summary: `پروندهٔ «${row.loser_snapshot?.name ?? "بدون نام"}» در این پرونده ادغام شد`,
        detail: row.merged_by || undefined,
      });
    }
  }

  return sortTimeline(events).slice(0, limit);
}
