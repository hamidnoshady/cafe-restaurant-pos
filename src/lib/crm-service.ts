/**
 * The CRM app's data layer: the customer file, notes, duplicate detection and
 * merge, consent with its audit trail, activities, deals and cases.
 *
 * `crm-shared.ts` holds the pure vocabulary (stages, statuses, labels, the
 * consent-merge rule); `segments.ts` and `crm-scoring.ts` hold the pure
 * engines. This file is the DB-touching half and, per repo convention, has no
 * direct unit test — its behaviour is pinned by
 * `integration/crm.integration.test.ts`.
 *
 * Three rules run through everything below, and each exists because its
 * absence would be a real bug rather than an untidiness:
 *
 * 1. **Consent changes are never silent.** Every write that touches
 *    `sms_consent`/`marketing_consent` also appends to `crm_consent_events`,
 *    in the same statement path, so "who turned this on?" always has an
 *    answer. That is the whole reason the messaging phase can be trusted.
 * 2. **A merge moves references and archives; it never deletes and never
 *    touches an accounting document.** A posted journal entry stays exactly as
 *    posted — a merge is a directory correction, not a ledger correction.
 * 3. **Nothing about a customer is inferred where it can be read.** RFM is
 *    stored only because quintiles are a whole-population computation; every
 *    other number on the file is derived at read time from the table that owns
 *    it.
 */

import { query, withTenant } from "./db";
import { businessToday } from "./business-day-service";
import { normalizePhone } from "./phone";
import {
  duplicateConfidence,
  mergeConsent,
  mergeTags,
  type ActivityKind,
  type CasePriority,
  type CaseStatus,
  type ConsentChannel,
  type ConsentSource,
  type DealStage,
  type DuplicateReason,
} from "./crm-shared";
import { lifetimeValue, scorePopulation, type CustomerRfmInput, type RfmScore } from "./crm-scoring";

// ---------------------------------------------------------------------------
// The customer file
// ---------------------------------------------------------------------------

export interface CustomerFile {
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  address: string | null;
  birthday: string | null;
  tags: string[];
  notes: string | null;
  smsConsent: boolean;
  marketingConsent: boolean;
  isActive: boolean;
  mergedIntoId: string | null;
  createdAt: string;
  /** Purchase aggregates, derived at read time. */
  stats: {
    orderCount: number;
    totalSpentRial: number;
    firstPurchaseDate: string | null;
    lastPurchaseDate: string | null;
    daysSinceLastPurchase: number | null;
    loyaltyPoints: number;
    openCases: number;
    openDeals: number;
    lifetime: ReturnType<typeof lifetimeValue>;
  };
  rfm: {
    recency: number | null;
    frequency: number | null;
    monetary: number | null;
    stage: string | null;
    scoredAt: string | null;
  };
}

/**
 * One customer, with everything the file page shows above the timeline.
 *
 * The aggregates use the same business-day bucketing and the same
 * "completed orders only" rule as `crm-segments-service.ts`, because a
 * customer whose file says «۱۲ خرید» must be in the segment that asks for
 * «حداقل ۱۲ خرید».
 */
export async function getCustomerFile(
  businessId: string,
  customerId: string,
): Promise<CustomerFile | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT c.id, c.name, c.phone, c.phone_e164 AS "phoneE164", c.email, c.address,
            c.birthday::text AS birthday, c.tags, c.notes,
            c.sms_consent AS "smsConsent", c.marketing_consent AS "marketingConsent",
            c.is_active AS "isActive", c.merged_into_id AS "mergedIntoId",
            c.created_at AS "createdAt",
            c.rfm_recency AS "rfmRecency", c.rfm_frequency AS "rfmFrequency",
            c.rfm_monetary AS "rfmMonetary", c.lifecycle_stage AS "lifecycleStage",
            c.rfm_scored_at AS "rfmScoredAt",
            coalesce(os.order_count, 0)::int      AS "orderCount",
            coalesce(os.total_spent, 0)::bigint   AS "totalSpentRial",
            os.first_purchase_date::text          AS "firstPurchaseDate",
            os.last_purchase_date::text           AS "lastPurchaseDate",
            coalesce(ps.points, 0)::int           AS "loyaltyPoints",
            coalesce(oc.open_cases, 0)::int       AS "openCases",
            coalesce(od.open_deals, 0)::int       AS "openDeals"
       FROM customers c
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS order_count,
                coalesce(sum(o.total), 0)::bigint AS total_spent,
                min(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) AS first_purchase_date,
                max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes)) AS last_purchase_date
           FROM orders o
           JOIN locations l ON l.id = o.location_id
          WHERE o.customer_id = c.id AND l.business_id = $1
            AND o.status = 'completed' AND o.closed_at IS NOT NULL
       ) os ON true
       LEFT JOIN LATERAL (
         SELECT coalesce(sum(points), 0)::int AS points
           FROM customer_points WHERE customer_id = c.id AND business_id = $1
       ) ps ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS open_cases FROM crm_cases
          WHERE customer_id = c.id AND business_id = $1
            AND status IN ('open', 'in_progress', 'waiting')
       ) oc ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS open_deals FROM crm_deals
          WHERE customer_id = c.id AND business_id = $1 AND stage NOT IN ('won', 'lost')
       ) od ON true
      WHERE c.business_id = $1 AND c.id = $2`,
    [businessId, customerId],
  );
  const row = rows[0];
  if (!row) return null;

  const today = await businessToday(businessId);
  const lastPurchaseDate = (row.lastPurchaseDate as string | null) ?? null;
  const firstPurchaseDate = (row.firstPurchaseDate as string | null) ?? null;
  const orderCount = Number(row.orderCount ?? 0);
  const totalSpentRial = Number(row.totalSpentRial ?? 0);

  const dayDiff = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

  return {
    id: row.id as string,
    name: row.name as string,
    phone: (row.phone as string | null) ?? null,
    phoneE164: (row.phoneE164 as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    birthday: (row.birthday as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? [],
    notes: (row.notes as string | null) ?? null,
    smsConsent: Boolean(row.smsConsent),
    marketingConsent: Boolean(row.marketingConsent),
    isActive: Boolean(row.isActive),
    mergedIntoId: (row.mergedIntoId as string | null) ?? null,
    createdAt: String(row.createdAt),
    stats: {
      orderCount,
      totalSpentRial,
      firstPurchaseDate,
      lastPurchaseDate,
      daysSinceLastPurchase: lastPurchaseDate ? dayDiff(lastPurchaseDate, today) : null,
      loyaltyPoints: Number(row.loyaltyPoints ?? 0),
      openCases: Number(row.openCases ?? 0),
      openDeals: Number(row.openDeals ?? 0),
      lifetime: lifetimeValue({
        totalSpentRial,
        orderCount,
        activeDays:
          firstPurchaseDate && lastPurchaseDate ? dayDiff(firstPurchaseDate, lastPurchaseDate) : 0,
      }),
    },
    rfm: {
      recency: (row.rfmRecency as number | null) ?? null,
      frequency: (row.rfmFrequency as number | null) ?? null,
      monetary: (row.rfmMonetary as number | null) ?? null,
      stage: (row.lifecycleStage as string | null) ?? null,
      scoredAt: (row.rfmScoredAt as string | null) ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export interface CustomerNote extends Record<string, unknown> {
  id: string;
  customerId: string;
  body: string;
  isPinned: boolean;
  createdBy: string;
  createdAt: string;
}

const NOTE_COLUMNS = `id, customer_id AS "customerId", body, is_pinned AS "isPinned",
  created_by AS "createdBy", created_at AS "createdAt"`;

export async function listCustomerNotes(
  businessId: string,
  customerId: string,
): Promise<CustomerNote[]> {
  const { rows } = await query<CustomerNote>(
    `SELECT ${NOTE_COLUMNS} FROM customer_notes
      WHERE business_id = $1 AND customer_id = $2
      ORDER BY is_pinned DESC, created_at DESC`,
    [businessId, customerId],
  );
  return rows;
}

export async function addCustomerNote(
  businessId: string,
  customerId: string,
  input: { body: string; isPinned?: boolean; createdBy?: string },
): Promise<CustomerNote> {
  const { rows } = await query<CustomerNote>(
    `INSERT INTO customer_notes (business_id, customer_id, body, is_pinned, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${NOTE_COLUMNS}`,
    [businessId, customerId, input.body.trim(), input.isPinned ?? false, input.createdBy ?? ""],
  );
  return rows[0];
}

export async function deleteCustomerNote(businessId: string, noteId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM customer_notes WHERE business_id = $1 AND id = $2`, [
    businessId,
    noteId,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function toggleNotePin(
  businessId: string,
  noteId: string,
  pinned: boolean,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE customer_notes SET is_pinned = $3 WHERE business_id = $1 AND id = $2`,
    [businessId, noteId, pinned],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Consent — every change is an event
// ---------------------------------------------------------------------------

export interface ConsentUpdate {
  channel: ConsentChannel;
  granted: boolean;
  source?: ConsentSource;
  note?: string;
  changedBy?: string;
}

/**
 * Set a consent flag and record why.
 *
 * The UPDATE and the audit INSERT are one transaction: a consent change whose
 * event failed to write would be a change nobody can account for, which is
 * exactly the situation the audit exists to prevent. Writing the event first
 * and the flag second would have the same hole in the other direction, so
 * both go in one `withTenant` transaction.
 *
 * No-ops are still recorded when they arrive with a *reason* — a customer
 * confirming "yes, keep sending" is a fact worth having — but a redundant
 * write from a UI toggle that did not actually change anything is dropped, so
 * the trail stays readable.
 */
export async function setConsent(
  businessId: string,
  customerId: string,
  update: ConsentUpdate,
): Promise<{ changed: boolean; smsConsent: boolean; marketingConsent: boolean } | null> {
  const column = update.channel === "sms" ? "sms_consent" : "marketing_consent";

  return withTenant(businessId, async () => {
    const { rows: current } = await query<{ sms_consent: boolean; marketing_consent: boolean }>(
      `SELECT sms_consent, marketing_consent FROM customers WHERE business_id = $1 AND id = $2`,
      [businessId, customerId],
    );
    if (!current[0]) return null;

    const before = update.channel === "sms" ? current[0].sms_consent : current[0].marketing_consent;
    const changed = before !== update.granted;
    const hasReason = Boolean(update.note?.trim()) || update.source === "customer_request";

    if (changed) {
      await query(
        `UPDATE customers SET ${column} = $3, updated_at = now() WHERE business_id = $1 AND id = $2`,
        [businessId, customerId, update.granted],
      );
    }
    if (changed || hasReason) {
      await query(
        `INSERT INTO crm_consent_events (business_id, customer_id, channel, granted, source, note, changed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          businessId,
          customerId,
          update.channel,
          update.granted,
          update.source ?? "staff",
          update.note?.trim() ?? "",
          update.changedBy ?? "",
        ],
      );
    }

    return {
      changed,
      smsConsent: update.channel === "sms" ? update.granted : current[0].sms_consent,
      marketingConsent:
        update.channel === "email" ? update.granted : current[0].marketing_consent,
    };
  });
}

export interface ConsentEvent extends Record<string, unknown> {
  id: string;
  customerId: string;
  customerName: string;
  channel: string;
  granted: boolean;
  source: string;
  note: string;
  changedBy: string;
  createdAt: string;
}

/** The consent audit trail, business-wide or for one customer. */
export async function listConsentEvents(
  businessId: string,
  options: { customerId?: string; limit?: number } = {},
): Promise<ConsentEvent[]> {
  const params: unknown[] = [businessId];
  let where = "e.business_id = $1";
  if (options.customerId) {
    params.push(options.customerId);
    where += ` AND e.customer_id = $${params.length}`;
  }
  params.push(options.limit ?? 200);
  const { rows } = await query<ConsentEvent>(
    `SELECT e.id, e.customer_id AS "customerId", c.name AS "customerName",
            e.channel, e.granted, e.source, e.note, e.changed_by AS "changedBy",
            e.created_at AS "createdAt"
       FROM crm_consent_events e
       JOIN customers c ON c.id = e.customer_id
      WHERE ${where}
      ORDER BY e.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

/** Consent coverage — «چقدر از فاز بعد قابل استفاده است». */
export async function consentCoverage(businessId: string): Promise<{
  total: number;
  smsGranted: number;
  emailGranted: number;
  withMobile: number;
  withEmail: number;
  smsReachable: number;
  emailReachable: number;
}> {
  const { rows } = await query<Record<string, string>>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE sms_consent)::text AS sms_granted,
            count(*) FILTER (WHERE marketing_consent)::text AS email_granted,
            count(*) FILTER (WHERE phone_e164 IS NOT NULL)::text AS with_mobile,
            count(*) FILTER (WHERE email IS NOT NULL AND btrim(email) <> '')::text AS with_email,
            count(*) FILTER (WHERE sms_consent AND phone_e164 IS NOT NULL)::text AS sms_reachable,
            count(*) FILTER (WHERE marketing_consent AND email IS NOT NULL AND btrim(email) <> '')::text AS email_reachable
       FROM customers
      WHERE business_id = $1 AND merged_into_id IS NULL`,
    [businessId],
  );
  const row = rows[0] ?? {};
  const n = (key: string) => Number(row[key] ?? 0);
  return {
    total: n("total"),
    smsGranted: n("sms_granted"),
    emailGranted: n("email_granted"),
    withMobile: n("with_mobile"),
    withEmail: n("with_email"),
    // Consent alone is not reachability: consent plus a number an SMS can
    // actually arrive at is. The gap between these two is what makes a
    // campaign under-deliver, so both are reported.
    smsReachable: n("sms_reachable"),
    emailReachable: n("email_reachable"),
  };
}

// ---------------------------------------------------------------------------
// Duplicates and merge
// ---------------------------------------------------------------------------

export interface DuplicateCandidate {
  reason: DuplicateReason;
  confidence: number;
  left: { id: string; name: string; phone: string | null; email: string | null; orderCount: number; createdAt: string };
  right: { id: string; name: string; phone: string | null; email: string | null; orderCount: number; createdAt: string };
}

/**
 * Find probable duplicates.
 *
 * Matching is on the **canonical phone** (`phone_e164`, produced by
 * `phone.ts`) rather than the typed string, which is the only reason this
 * finds anything at all: `0912…` and `+98912…` are the same customer and
 * different text. Email matches case-insensitively; an identical *name* alone
 * is offered at low confidence because «محمد محمدی» is not one person.
 *
 * Nothing here merges. The result is a list of questions for a human.
 */
export async function findDuplicates(
  businessId: string,
  options: { limit?: number } = {},
): Promise<DuplicateCandidate[]> {
  const limit = options.limit ?? 50;
  const candidates: DuplicateCandidate[] = [];

  const selectPair = `
    a.id AS left_id, a.name AS left_name, a.phone AS left_phone, a.email AS left_email,
    a.created_at AS left_created,
    (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE o.customer_id = a.id AND l.business_id = $1)::int AS left_orders,
    b.id AS right_id, b.name AS right_name, b.phone AS right_phone, b.email AS right_email,
    b.created_at AS right_created,
    (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
      WHERE o.customer_id = b.id AND l.business_id = $1)::int AS right_orders
  `;

  // `pg` hands back a JS Date for timestamptz. `String(date)` would emit
  // "Sat Aug 29 2026 …", which every other CRM route avoids by letting JSON
  // serialise the Date to ISO. Normalising here keeps one date format across
  // the whole API rather than one screen's worth of exception.
  const isoOf = (value: unknown): string =>
    value instanceof Date ? value.toISOString() : String(value);

  const push = (reason: DuplicateReason, row: Record<string, unknown>) => {
    candidates.push({
      reason,
      confidence: duplicateConfidence(reason),
      left: {
        id: row.left_id as string,
        name: row.left_name as string,
        phone: (row.left_phone as string | null) ?? null,
        email: (row.left_email as string | null) ?? null,
        orderCount: Number(row.left_orders ?? 0),
        createdAt: isoOf(row.left_created),
      },
      right: {
        id: row.right_id as string,
        name: row.right_name as string,
        phone: (row.right_phone as string | null) ?? null,
        email: (row.right_email as string | null) ?? null,
        orderCount: Number(row.right_orders ?? 0),
        createdAt: isoOf(row.right_created),
      },
    });
  };

  // `a.id < b.id` yields each unordered pair exactly once — without it every
  // duplicate would be reported twice, mirrored.
  const { rows: byPhone } = await query<Record<string, unknown>>(
    `SELECT ${selectPair} FROM customers a JOIN customers b
        ON b.business_id = a.business_id AND b.phone_e164 = a.phone_e164 AND a.id < b.id
      WHERE a.business_id = $1 AND a.phone_e164 IS NOT NULL
        AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL
      LIMIT $2`,
    [businessId, limit],
  );
  byPhone.forEach((row) => push("phone", row));

  const { rows: byEmail } = await query<Record<string, unknown>>(
    `SELECT ${selectPair} FROM customers a JOIN customers b
        ON b.business_id = a.business_id AND lower(b.email) = lower(a.email) AND a.id < b.id
      WHERE a.business_id = $1 AND a.email IS NOT NULL AND btrim(a.email) <> ''
        AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL
        -- Already reported by the stronger phone rule; reporting the same pair
        -- twice would make the list look worse than the data is.
        AND (a.phone_e164 IS NULL OR b.phone_e164 IS NULL OR a.phone_e164 <> b.phone_e164)
      LIMIT $2`,
    [businessId, limit],
  );
  byEmail.forEach((row) => push("email", row));

  const { rows: byName } = await query<Record<string, unknown>>(
    `SELECT ${selectPair} FROM customers a JOIN customers b
        ON b.business_id = a.business_id
       AND lower(btrim(b.name)) = lower(btrim(a.name)) AND a.id < b.id
      WHERE a.business_id = $1 AND btrim(a.name) <> ''
        AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL
        AND (a.phone_e164 IS NULL OR b.phone_e164 IS NULL OR a.phone_e164 <> b.phone_e164)
        AND (a.email IS NULL OR b.email IS NULL OR lower(a.email) <> lower(b.email))
      LIMIT $2`,
    [businessId, limit],
  );
  byName.forEach((row) => push("name", row));

  return candidates.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}

export interface MergePreview {
  winner: { id: string; name: string };
  loser: { id: string; name: string };
  moves: Record<string, number>;
  /** The consent the merged record will end up with, and why. */
  resultingConsent: { smsConsent: boolean; marketingConsent: boolean };
  resultingTags: string[];
}

/** Reference counts for the merge preview — «چه چیزی به کجا می‌رود». */
async function countReferences(
  businessId: string,
  customerId: string,
): Promise<Record<string, number>> {
  const { rows } = await query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM orders o JOIN locations l ON l.id = o.location_id
         WHERE o.customer_id = $2 AND l.business_id = $1)::text AS orders,
       (SELECT count(*) FROM customer_points WHERE customer_id = $2 AND business_id = $1)::text AS points,
       (SELECT count(*) FROM reservations r JOIN locations l ON l.id = r.location_id
         WHERE r.customer_id = $2 AND l.business_id = $1)::text AS reservations,
       (SELECT count(*) FROM ar_receipts WHERE customer_id = $2 AND business_id = $1)::text AS receipts,
       (SELECT count(*) FROM customer_notes WHERE customer_id = $2 AND business_id = $1)::text AS notes,
       (SELECT count(*) FROM crm_activities WHERE customer_id = $2 AND business_id = $1)::text AS activities,
       (SELECT count(*) FROM crm_deals WHERE customer_id = $2 AND business_id = $1)::text AS deals,
       (SELECT count(*) FROM crm_cases WHERE customer_id = $2 AND business_id = $1)::text AS cases,
       (SELECT count(*) FROM crm_consent_events WHERE customer_id = $2 AND business_id = $1)::text AS consent_events`,
    [businessId, customerId],
  );
  const row = rows[0] ?? {};
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value ?? 0)]));
}

export async function previewMerge(
  businessId: string,
  winnerId: string,
  loserId: string,
): Promise<MergePreview | null> {
  if (winnerId === loserId) return null;
  const { rows } = await query<{
    id: string;
    name: string;
    tags: string[] | null;
    sms_consent: boolean;
    marketing_consent: boolean;
  }>(
    `SELECT id, name, tags, sms_consent, marketing_consent
       FROM customers WHERE business_id = $1 AND id = ANY($2::uuid[])`,
    [businessId, [winnerId, loserId]],
  );
  const winner = rows.find((row) => row.id === winnerId);
  const loser = rows.find((row) => row.id === loserId);
  if (!winner || !loser) return null;

  return {
    winner: { id: winner.id, name: winner.name },
    loser: { id: loser.id, name: loser.name },
    moves: await countReferences(businessId, loserId),
    resultingConsent: {
      // Intersection, not union — see mergeConsent's doc comment.
      smsConsent: mergeConsent(winner.sms_consent, loser.sms_consent),
      marketingConsent: mergeConsent(winner.marketing_consent, loser.marketing_consent),
    },
    resultingTags: mergeTags(winner.tags, loser.tags),
  };
}

export interface MergeResult {
  winnerId: string;
  loserId: string;
  moved: Record<string, number>;
}

/**
 * Merge two customer records.
 *
 * What it does, in one transaction:
 * - repoints every reference (orders, points, reservations, AR receipts, notes,
 *   activities, deals, cases, consent events) at the winner;
 * - unions the tags, **intersects** the consent, and fills any field the winner
 *   left blank from the loser;
 * - archives the loser (`is_active = false`, `merged_into_id = winner`) rather
 *   than deleting it, so nothing that referenced it can dangle;
 * - writes a `crm_merges` row recording exactly what moved.
 *
 * What it deliberately does **not** do: touch a single accounting document. An
 * order that was posted stays posted, with the same total, on the same date, in
 * the same period. Re-pointing `orders.customer_id` changes who the sale is
 * attributed to in the CRM; it changes no journal line, so the trial balance
 * before and after a merge is identical. That property is asserted in the
 * integration test, because it is the one an accountant would ask about.
 *
 * Irreversible, and therefore never automatic: `findDuplicates` proposes, a
 * human disposes. It is also not an `ACTION_CATALOG` entry, so no assistant,
 * autopilot job or MCP client can reach it.
 */
export async function mergeCustomers(
  businessId: string,
  winnerId: string,
  loserId: string,
  options: { mergedBy?: string } = {},
): Promise<MergeResult | null> {
  if (winnerId === loserId) return null;

  return withTenant(businessId, async () => {
    const { rows } = await query<{
      id: string;
      name: string;
      phone: string | null;
      phone_e164: string | null;
      email: string | null;
      address: string | null;
      birthday: string | null;
      notes: string | null;
      tags: string[] | null;
      sms_consent: boolean;
      marketing_consent: boolean;
      merged_into_id: string | null;
    }>(
      `SELECT id, name, phone, phone_e164, email, address, birthday::text AS birthday,
              notes, tags, sms_consent, marketing_consent, merged_into_id
         FROM customers WHERE business_id = $1 AND id = ANY($2::uuid[]) FOR UPDATE`,
      [businessId, [winnerId, loserId]],
    );
    const winner = rows.find((row) => row.id === winnerId);
    const loser = rows.find((row) => row.id === loserId);
    // A record that already lost a merge must not be merged again — that would
    // produce a chain whose history is unreadable.
    if (!winner || !loser || loser.merged_into_id || winner.merged_into_id) return null;

    const moved = await countReferences(businessId, loserId);

    // Re-point references. Each is scoped by business_id (or by the location's
    // business) so a merge can never reach across tenants even if ids leaked.
    await query(
      `UPDATE orders o SET customer_id = $3
         FROM locations l WHERE l.id = o.location_id AND l.business_id = $1 AND o.customer_id = $2`,
      [businessId, loserId, winnerId],
    );
    await query(
      `UPDATE reservations r SET customer_id = $3
         FROM locations l WHERE l.id = r.location_id AND l.business_id = $1 AND r.customer_id = $2`,
      [businessId, loserId, winnerId],
    );
    for (const table of [
      "customer_points",
      "ar_receipts",
      "customer_notes",
      "crm_activities",
      "crm_deals",
      "crm_cases",
      "crm_consent_events",
    ]) {
      await query(
        `UPDATE ${table} SET customer_id = $3 WHERE business_id = $1 AND customer_id = $2`,
        [businessId, loserId, winnerId],
      );
    }
    // Repair tickets are location-scoped like orders, and only exist for the
    // trades that have them; the UPDATE is a no-op elsewhere.
    await query(
      `UPDATE repair_tickets rt SET customer_id = $3
         FROM locations l WHERE l.id = rt.location_id AND l.business_id = $1 AND rt.customer_id = $2`,
      [businessId, loserId, winnerId],
    );

    // Field-level merge: union the tags, intersect the consent, and fill the
    // winner's empty fields from the loser (a blank is not a decision).
    await query(
      `UPDATE customers
          SET tags = $3,
              sms_consent = $4,
              marketing_consent = $5,
              phone = coalesce(nullif(btrim(phone), ''), $6),
              phone_e164 = coalesce(phone_e164, $7),
              email = coalesce(nullif(btrim(email), ''), $8),
              address = coalesce(nullif(btrim(address), ''), $9),
              birthday = coalesce(birthday, $10::date),
              notes = coalesce(nullif(btrim(notes), ''), $11),
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        winnerId,
        mergeTags(winner.tags, loser.tags),
        mergeConsent(winner.sms_consent, loser.sms_consent),
        mergeConsent(winner.marketing_consent, loser.marketing_consent),
        loser.phone,
        loser.phone_e164,
        loser.email,
        loser.address,
        loser.birthday,
        loser.notes,
      ],
    );

    // Archive, never delete: an id that was referenced anywhere must stay
    // resolvable, and the merge record itself points at it.
    await query(
      `UPDATE customers SET is_active = false, merged_into_id = $3, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, loserId, winnerId],
    );

    // If the merge lost a consent the winner had, that is a consent *change*
    // and belongs in the audit trail like any other.
    for (const channel of ["sms", "email"] as const) {
      const winnerHad = channel === "sms" ? winner.sms_consent : winner.marketing_consent;
      const loserHad = channel === "sms" ? loser.sms_consent : loser.marketing_consent;
      if (winnerHad && !mergeConsent(winnerHad, loserHad)) {
        await query(
          `INSERT INTO crm_consent_events (business_id, customer_id, channel, granted, source, note, changed_by)
           VALUES ($1, $2, $3, false, 'merge', $4, $5)`,
          [
            businessId,
            winnerId,
            channel,
            `در ادغام با پروندهٔ «${loser.name}» که اجازه نداده بود، لغو شد.`,
            options.mergedBy ?? "",
          ],
        );
      }
    }

    await query(
      `INSERT INTO crm_merges (business_id, winner_id, loser_id, moved_counts, loser_snapshot, merged_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        businessId,
        winnerId,
        loserId,
        JSON.stringify(moved),
        JSON.stringify({
          name: loser.name,
          phone: loser.phone,
          email: loser.email,
          tags: loser.tags ?? [],
        }),
        options.mergedBy ?? "",
      ],
    );

    return { winnerId, loserId, moved };
  });
}

// ---------------------------------------------------------------------------
// RFM recompute
// ---------------------------------------------------------------------------

/**
 * Recompute every customer's RFM score and lifecycle stage.
 *
 * Whole-population, because quintiles are relative — there is no such thing as
 * scoring one customer. That is also why the result is *stored*: recomputing
 * on every list render would mean reading every order on every page load.
 * Callers refresh it from the CRM dashboard, and every screen treats a null
 * score as "not scored yet" rather than as zero.
 */
export async function recomputeRfm(businessId: string): Promise<{ scored: number; anchorDate: string }> {
  const anchorDate = await businessToday(businessId);
  const { rows } = await query<{
    customer_id: string;
    name: string;
    last_purchase_date: string | null;
    order_count: number;
    total_spent: string;
  }>(
    `SELECT c.id AS customer_id, c.name,
            max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes))::text AS last_purchase_date,
            count(o.id)::int AS order_count,
            coalesce(sum(o.total), 0)::text AS total_spent
       FROM customers c
       LEFT JOIN orders o
         ON o.customer_id = c.id AND o.status = 'completed' AND o.closed_at IS NOT NULL
       LEFT JOIN locations l ON l.id = o.location_id AND l.business_id = $1
      WHERE c.business_id = $1 AND c.merged_into_id IS NULL
      GROUP BY c.id, c.name`,
    [businessId],
  );

  const input: CustomerRfmInput[] = rows.map((row) => ({
    customerId: row.customer_id,
    name: row.name,
    lastPurchaseDate: row.last_purchase_date,
    orderCount: Number(row.order_count ?? 0),
    totalSpentRial: Number(row.total_spent ?? 0),
  }));

  const scores = scorePopulation(input, anchorDate);
  if (scores.length === 0) return { scored: 0, anchorDate };

  // One statement rather than N updates: a business with 20k customers would
  // otherwise issue 20k round trips for what is a single derived column set.
  await query(
    `UPDATE customers c
        SET rfm_recency = v.recency, rfm_frequency = v.frequency, rfm_monetary = v.monetary,
            lifecycle_stage = v.stage, rfm_scored_at = now()
       FROM (
         SELECT unnest($2::uuid[]) AS id, unnest($3::int[]) AS recency,
                unnest($4::int[]) AS frequency, unnest($5::int[]) AS monetary,
                unnest($6::text[]) AS stage
       ) v
      WHERE c.business_id = $1 AND c.id = v.id`,
    [
      businessId,
      scores.map((s) => s.customerId),
      scores.map((s) => s.recency),
      scores.map((s) => s.frequency),
      scores.map((s) => s.monetary),
      scores.map((s) => s.stage),
    ],
  );

  return { scored: scores.length, anchorDate };
}

/** The scored population, for the dashboard's distribution and leaderboards. */
export async function scoredPopulation(businessId: string): Promise<RfmScore[]> {
  const anchorDate = await businessToday(businessId);
  const { rows } = await query<{
    customer_id: string;
    name: string;
    last_purchase_date: string | null;
    order_count: number;
    total_spent: string;
  }>(
    `SELECT c.id AS customer_id, c.name,
            max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes))::text AS last_purchase_date,
            count(o.id)::int AS order_count,
            coalesce(sum(o.total), 0)::text AS total_spent
       FROM customers c
       LEFT JOIN orders o
         ON o.customer_id = c.id AND o.status = 'completed' AND o.closed_at IS NOT NULL
       LEFT JOIN locations l ON l.id = o.location_id AND l.business_id = $1
      WHERE c.business_id = $1 AND c.merged_into_id IS NULL
      GROUP BY c.id, c.name`,
    [businessId],
  );
  return scorePopulation(
    rows.map((row) => ({
      customerId: row.customer_id,
      name: row.name,
      lastPurchaseDate: row.last_purchase_date,
      orderCount: Number(row.order_count ?? 0),
      totalSpentRial: Number(row.total_spent ?? 0),
    })),
    anchorDate,
  );
}

/** Keep `phone_e164` in step with a typed phone number — called on customer create/update. */
export async function syncCustomerPhone(
  businessId: string,
  customerId: string,
  phone: string | null,
): Promise<void> {
  const e164 = phone ? normalizePhone(phone).e164 : null;
  await query(`UPDATE customers SET phone_e164 = $3 WHERE business_id = $1 AND id = $2`, [
    businessId,
    customerId,
    e164,
  ]);
}

/**
 * Add or remove a single tag, returning the resulting list — or null when the
 * customer does not exist.
 *
 * The array is rewritten by the database from its own current value
 * (`array_append`/`array_remove` on the stored column), never from a value the
 * caller read a moment ago. Two people tagging the same customer at the same
 * instant therefore both keep their tag; a read-modify-write in application
 * code would silently drop one of them.
 */
export async function setCustomerTag(
  businessId: string,
  customerId: string,
  tag: string,
  action: "add" | "remove",
): Promise<string[] | null> {
  const clean = tag.trim();
  if (!clean) return null;

  const { rows } = await query<{ tags: string[] }>(
    action === "add"
      ? `UPDATE customers
            SET tags = CASE WHEN $3 = ANY(COALESCE(tags, '{}')) THEN tags
                            ELSE array_append(COALESCE(tags, '{}'), $3) END
          WHERE business_id = $1 AND id = $2
        RETURNING COALESCE(tags, '{}') AS tags`
      : `UPDATE customers
            SET tags = array_remove(COALESCE(tags, '{}'), $3)
          WHERE business_id = $1 AND id = $2
        RETURNING COALESCE(tags, '{}') AS tags`,
    [businessId, customerId, clean],
  );
  return rows[0]?.tags ?? null;
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export interface CrmActivity extends Record<string, unknown> {
  id: string;
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  caseId: string | null;
  kind: ActivityKind;
  subject: string;
  body: string;
  dueAt: string | null;
  completedAt: string | null;
  assignedTo: string;
  createdBy: string;
  createdAt: string;
}

const ACTIVITY_COLUMNS = `a.id, a.customer_id AS "customerId", c.name AS "customerName",
  a.deal_id AS "dealId", a.case_id AS "caseId", a.kind, a.subject, a.body,
  a.due_at AS "dueAt", a.completed_at AS "completedAt", a.assigned_to AS "assignedTo",
  a.created_by AS "createdBy", a.created_at AS "createdAt"`;

export async function listActivities(
  businessId: string,
  options: {
    customerId?: string;
    dealId?: string;
    caseId?: string;
    openOnly?: boolean;
    assignedTo?: string;
    limit?: number;
  } = {},
): Promise<CrmActivity[]> {
  const params: unknown[] = [businessId];
  let where = "a.business_id = $1";
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    where += ` AND ${fragment.replace("$n", `$${params.length}`)}`;
  };
  if (options.customerId) add("a.customer_id = $n", options.customerId);
  if (options.dealId) add("a.deal_id = $n", options.dealId);
  if (options.caseId) add("a.case_id = $n", options.caseId);
  if (options.assignedTo) add("a.assigned_to = $n", options.assignedTo);
  if (options.openOnly) where += " AND a.completed_at IS NULL";
  params.push(options.limit ?? 100);

  const { rows } = await query<CrmActivity>(
    `SELECT ${ACTIVITY_COLUMNS}
       FROM crm_activities a
       LEFT JOIN customers c ON c.id = a.customer_id
      WHERE ${where}
      ORDER BY a.completed_at IS NOT NULL, coalesce(a.due_at, a.created_at)
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export interface CreateActivityInput {
  customerId?: string | null;
  dealId?: string | null;
  caseId?: string | null;
  kind: ActivityKind;
  subject: string;
  body?: string;
  dueAt?: string | null;
  assignedTo?: string;
  createdBy?: string;
  completed?: boolean;
}

export async function createActivity(
  businessId: string,
  input: CreateActivityInput,
): Promise<CrmActivity> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_activities
       (business_id, customer_id, deal_id, case_id, kind, subject, body, due_at, assigned_to, created_by, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      businessId,
      input.customerId ?? null,
      input.dealId ?? null,
      input.caseId ?? null,
      input.kind,
      input.subject.trim(),
      input.body?.trim() ?? "",
      input.dueAt ?? null,
      input.assignedTo ?? "",
      input.createdBy ?? "",
      input.completed ? new Date().toISOString() : null,
    ],
  );
  return (await getActivity(businessId, rows[0].id))!;
}

/** One activity by id — the read every write path returns through. */
export async function getActivity(businessId: string, activityId: string): Promise<CrmActivity | null> {
  const { rows } = await query<CrmActivity>(
    `SELECT ${ACTIVITY_COLUMNS}
       FROM crm_activities a
       LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.business_id = $1 AND a.id = $2`,
    [businessId, activityId],
  );
  return rows[0] ?? null;
}

export async function completeActivity(
  businessId: string,
  activityId: string,
  completed: boolean,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE crm_activities SET completed_at = $3, updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, activityId, completed ? new Date().toISOString() : null],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteActivity(businessId: string, activityId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM crm_activities WHERE business_id = $1 AND id = $2`, [
    businessId,
    activityId,
  ]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Deals
// ---------------------------------------------------------------------------

export interface CrmDeal extends Record<string, unknown> {
  id: string;
  customerId: string | null;
  customerName: string | null;
  title: string;
  description: string;
  stage: DealStage;
  valueRial: number;
  probability: number | null;
  expectedCloseDate: string | null;
  ownerUser: string;
  source: string;
  closedAt: string | null;
  lostReason: string | null;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

const DEAL_COLUMNS = `d.id, d.customer_id AS "customerId", c.name AS "customerName",
  d.title, d.description, d.stage, d.value_rial AS "valueRial", d.probability,
  d.expected_close_date::text AS "expectedCloseDate", d.owner_user AS "ownerUser",
  d.source, d.closed_at AS "closedAt", d.lost_reason AS "lostReason",
  d.order_id AS "orderId", d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;

export async function listDeals(
  businessId: string,
  options: { customerId?: string; stage?: DealStage; openOnly?: boolean; limit?: number } = {},
): Promise<CrmDeal[]> {
  const params: unknown[] = [businessId];
  let where = "d.business_id = $1";
  if (options.customerId) {
    params.push(options.customerId);
    where += ` AND d.customer_id = $${params.length}`;
  }
  if (options.stage) {
    params.push(options.stage);
    where += ` AND d.stage = $${params.length}`;
  }
  if (options.openOnly) where += " AND d.stage NOT IN ('won', 'lost')";
  params.push(options.limit ?? 200);

  const { rows } = await query<CrmDeal>(
    `SELECT ${DEAL_COLUMNS} FROM crm_deals d
       LEFT JOIN customers c ON c.id = d.customer_id
      WHERE ${where}
      ORDER BY d.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({ ...row, valueRial: Number(row.valueRial) }));
}

export interface UpsertDealInput {
  id?: string;
  customerId?: string | null;
  title: string;
  description?: string;
  stage?: DealStage;
  valueRial?: number;
  probability?: number | null;
  expectedCloseDate?: string | null;
  ownerUser?: string;
  source?: string;
  lostReason?: string | null;
  orderId?: string | null;
  createdBy?: string;
}

/**
 * Create or update a deal.
 *
 * `closed_at` is maintained here rather than by the caller: reaching `won` or
 * `lost` *is* closing, and leaving that to each call site is how half the rows
 * end up with a terminal stage and no close date. Moving a deal back out of a
 * terminal stage clears it again, so a mis-click is fully reversible.
 *
 * No ledger write happens on `won`, by design — see the note on `crm_deals` in
 * migration 0118.
 */
export async function upsertDeal(businessId: string, input: UpsertDealInput): Promise<CrmDeal> {
  const stage = input.stage ?? "lead";
  const terminal = stage === "won" || stage === "lost";

  if (input.id) {
    await query(
      `UPDATE crm_deals
          SET customer_id = $3, title = $4, description = $5, stage = $6, value_rial = $7,
              probability = $8, expected_close_date = $9::date, owner_user = $10, source = $11,
              lost_reason = $12, order_id = $13,
              closed_at = CASE WHEN $14 THEN coalesce(closed_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        input.id,
        input.customerId ?? null,
        input.title.trim(),
        input.description?.trim() ?? "",
        stage,
        Math.max(0, Math.round(input.valueRial ?? 0)),
        input.probability ?? null,
        input.expectedCloseDate ?? null,
        input.ownerUser ?? "",
        input.source?.trim() ?? "",
        input.lostReason?.trim() || null,
        input.orderId ?? null,
        terminal,
      ],
    );
    return (await getDeal(businessId, input.id))!;
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_deals
       (business_id, customer_id, title, description, stage, value_rial, probability,
        expected_close_date, owner_user, source, lost_reason, order_id, closed_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12,
             CASE WHEN $13 THEN now() ELSE NULL END, $14)
     RETURNING id`,
    [
      businessId,
      input.customerId ?? null,
      input.title.trim(),
      input.description?.trim() ?? "",
      stage,
      Math.max(0, Math.round(input.valueRial ?? 0)),
      input.probability ?? null,
      input.expectedCloseDate ?? null,
      input.ownerUser ?? "",
      input.source?.trim() ?? "",
      input.lostReason?.trim() || null,
      input.orderId ?? null,
      terminal,
      input.createdBy ?? "",
    ],
  );
  return (await getDeal(businessId, rows[0].id))!;
}

/** One deal by id — the read every write path returns through. */
export async function getDeal(businessId: string, dealId: string): Promise<CrmDeal | null> {
  const { rows } = await query<CrmDeal>(
    `SELECT ${DEAL_COLUMNS} FROM crm_deals d
       LEFT JOIN customers c ON c.id = d.customer_id
      WHERE d.business_id = $1 AND d.id = $2`,
    [businessId, dealId],
  );
  const row = rows[0];
  return row ? { ...row, valueRial: Number(row.valueRial) } : null;
}

export async function moveDealStage(
  businessId: string,
  dealId: string,
  stage: DealStage,
  options: { lostReason?: string } = {},
): Promise<boolean> {
  const terminal = stage === "won" || stage === "lost";
  const { rowCount } = await query(
    `UPDATE crm_deals
        SET stage = $3,
            lost_reason = CASE WHEN $3 = 'lost' THEN $4 ELSE NULL END,
            closed_at = CASE WHEN $5 THEN coalesce(closed_at, now()) ELSE NULL END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [businessId, dealId, stage, options.lostReason?.trim() ?? null, terminal],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteDeal(businessId: string, dealId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM crm_deals WHERE business_id = $1 AND id = $2`, [
    businessId,
    dealId,
  ]);
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface CrmCase extends Record<string, unknown> {
  id: string;
  customerId: string | null;
  customerName: string | null;
  subject: string;
  body: string;
  status: CaseStatus;
  priority: CasePriority;
  category: string;
  orderId: string | null;
  assignedTo: string;
  resolution: string;
  openedAt: string;
  resolvedAt: string | null;
  createdBy: string;
}

const CASE_COLUMNS = `k.id, k.customer_id AS "customerId", c.name AS "customerName",
  k.subject, k.body, k.status, k.priority, k.category, k.order_id AS "orderId",
  k.assigned_to AS "assignedTo", k.resolution, k.opened_at AS "openedAt",
  k.resolved_at AS "resolvedAt", k.created_by AS "createdBy"`;

export async function listCases(
  businessId: string,
  options: { customerId?: string; status?: CaseStatus; openOnly?: boolean; limit?: number } = {},
): Promise<CrmCase[]> {
  const params: unknown[] = [businessId];
  let where = "k.business_id = $1";
  if (options.customerId) {
    params.push(options.customerId);
    where += ` AND k.customer_id = $${params.length}`;
  }
  if (options.status) {
    params.push(options.status);
    where += ` AND k.status = $${params.length}`;
  }
  if (options.openOnly) where += " AND k.status IN ('open', 'in_progress', 'waiting')";
  params.push(options.limit ?? 200);

  const { rows } = await query<CrmCase>(
    `SELECT ${CASE_COLUMNS} FROM crm_cases k
       LEFT JOIN customers c ON c.id = k.customer_id
      WHERE ${where}
      ORDER BY
        CASE k.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        k.opened_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export interface UpsertCaseInput {
  id?: string;
  customerId?: string | null;
  subject: string;
  body?: string;
  status?: CaseStatus;
  priority?: CasePriority;
  category?: string;
  orderId?: string | null;
  assignedTo?: string;
  resolution?: string;
  createdBy?: string;
}

export async function upsertCase(businessId: string, input: UpsertCaseInput): Promise<CrmCase> {
  const status = input.status ?? "open";
  const resolved = status === "resolved" || status === "closed";

  if (input.id) {
    await query(
      `UPDATE crm_cases
          SET customer_id = $3, subject = $4, body = $5, status = $6, priority = $7,
              category = $8, order_id = $9, assigned_to = $10, resolution = $11,
              resolved_at = CASE WHEN $12 THEN coalesce(resolved_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        input.id,
        input.customerId ?? null,
        input.subject.trim(),
        input.body?.trim() ?? "",
        status,
        input.priority ?? "normal",
        input.category?.trim() ?? "",
        input.orderId ?? null,
        input.assignedTo ?? "",
        input.resolution?.trim() ?? "",
        resolved,
      ],
    );
    return (await getCase(businessId, input.id))!;
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_cases
       (business_id, customer_id, subject, body, status, priority, category, order_id,
        assigned_to, resolution, resolved_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             CASE WHEN $11 THEN now() ELSE NULL END, $12)
     RETURNING id`,
    [
      businessId,
      input.customerId ?? null,
      input.subject.trim(),
      input.body?.trim() ?? "",
      status,
      input.priority ?? "normal",
      input.category?.trim() ?? "",
      input.orderId ?? null,
      input.assignedTo ?? "",
      input.resolution?.trim() ?? "",
      resolved,
      input.createdBy ?? "",
    ],
  );
  return (await getCase(businessId, rows[0].id))!;
}

/** One case by id — the read every write path returns through. */
export async function getCase(businessId: string, caseId: string): Promise<CrmCase | null> {
  const { rows } = await query<CrmCase>(
    `SELECT ${CASE_COLUMNS} FROM crm_cases k
       LEFT JOIN customers c ON c.id = k.customer_id
      WHERE k.business_id = $1 AND k.id = $2`,
    [businessId, caseId],
  );
  return rows[0] ?? null;
}

export async function deleteCase(businessId: string, caseId: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM crm_cases WHERE business_id = $1 AND id = $2`, [
    businessId,
    caseId,
  ]);
  return (rowCount ?? 0) > 0;
}
