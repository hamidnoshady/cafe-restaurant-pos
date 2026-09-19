/**
 * Segments — storage, preview and resolution.
 *
 * `segments.ts` is the pure half: it turns a rule document into a parameterised
 * boolean expression and knows nothing about the database. This file is the
 * other half — it owns the one query shape those expressions are compiled
 * against, and it is **the only place an audience is produced**.
 *
 * ## The consent rule this file exists to enforce
 *
 * `resolveSegment(businessId, id, { purpose })` filters on consent *here*, in
 * the service, and not in any screen. That placement is the entire point:
 * a filter written in a component is a filter the next caller does not have,
 * and the next caller is the messaging phase, which sends real SMS to real
 * people. `purpose` has no default, so a caller cannot omit the question by
 * accident, and an unrecognised purpose fails closed (`consentPredicate`
 * returns FALSE) rather than widening the audience.
 *
 * ## Why one CTE, reused everywhere
 *
 * Preview, resolve, count and the AI's own tool must agree to the row. They
 * all run `segmentSourceSql()` — one definition of what a customer's
 * aggregates *are* — so a preview count of 42 is 42 when the campaign sends.
 * Two separately-written queries would eventually disagree, and the disagreement
 * would show up as "the campaign went to more people than the preview said".
 *
 * DB-touching, so per repo convention there is no direct unit test here; the
 * rules it compiles are unit-tested in `segments.test.ts` and the behaviour is
 * covered by `integration/crm.integration.test.ts`.
 */

import { query } from "./db";
import { businessToday } from "./business-day-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import {
  compileSegment,
  consentPredicate,
  validateSegmentDefinition,
  type SegmentDefinition,
  type SegmentPurpose,
} from "./segments";

export interface CustomerSegment extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  definition: SegmentDefinition;
  isBuiltin: boolean;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentMember extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  tags: string[];
  smsConsent: boolean;
  marketingConsent: boolean;
  isActive: boolean;
  lastPurchaseDate: string | null;
  orderCount: number;
  totalSpentRial: number;
  lifecycleStage: string | null;
}

/**
 * The customer aggregate every segment is evaluated against.
 *
 * Three decisions are baked in here, and each is the answer to a bug the naive
 * version would have:
 *
 * 1. **Sales are bucketed by the branch's business day** (`app_business_date`
 *    on the order's location), not by `opened_at::date`. A café trading
 *    18:00-03:00 files 01:00 under the previous trading day, and every other
 *    report in this codebase already agrees with that; a segment that used the
 *    calendar date would quietly disagree with the sales report next to it.
 * 2. **Only completed orders count.** An open ticket on a table is not a
 *    purchase, and a voided one never was. Counting either would inflate
 *    "total spent" for exactly the customers a win-back campaign targets.
 * 3. **Merged-away records are excluded.** A record that lost a merge is no
 *    longer a person; leaving it in would double-count the history that was
 *    just moved onto the winner.
 */
function segmentSourceSql(): string {
  return `
    WITH order_stats AS (
      SELECT o.customer_id,
             count(*)::int                     AS order_count,
             coalesce(sum(o.total), 0)::bigint AS total_spent,
             max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes))
                                               AS last_purchase_date,
             min(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes))
                                               AS first_purchase_date
        FROM orders o
        JOIN locations l ON l.id = o.location_id
       WHERE l.business_id = $1
         AND o.status = 'completed'
         AND o.closed_at IS NOT NULL
         AND o.customer_id IS NOT NULL
       GROUP BY o.customer_id
    ),
    point_stats AS (
      -- A segment's «امتیاز» rule must see the same spendable balance that
      -- loyalty redemption and Growth display. Historical expired points are
      -- useful in the timeline, but must not pull someone into a points-based
      -- offer after their credit has lapsed.
      SELECT customer_id, greatest(coalesce(sum(points), 0), 0)::int AS loyalty_points
        FROM customer_points
       WHERE business_id = $1
         AND (expires_at IS NULL OR expires_at >= current_date)
       GROUP BY customer_id
    ),
    -- The accounting bridge (Phase 36d). Same reconstruction as
    -- ar-service.listCustomerBalances: sum every journal line posted to the
    -- A/R control account, attributed to a customer through the order or the
    -- receipt that caused it. Deliberately NOT "unpaid orders" — that would
    -- ignore manual journal entries and credit notes and would let a segment
    -- disagree with the trial balance about who owes what.
    ar_stats AS (
      SELECT COALESCE(o.customer_id, r.customer_id) AS customer_id,
             coalesce(sum(jl.debit - jl.credit), 0)::bigint AS ar_balance
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN accounts a ON a.id = jl.account_id
        LEFT JOIN order_amendments am
               ON je.source_type = 'order_amendment' AND am.id = je.source_id
        LEFT JOIN orders o
               ON o.id = CASE WHEN je.source_type = 'order' THEN je.source_id ELSE am.order_id END
        LEFT JOIN ar_receipts r
               ON je.source_type = 'ar_receipt' AND r.id = je.source_id
       WHERE je.business_id = $1
         AND a.business_id = $1
         AND a.code = '${WELL_KNOWN_CODES.accountsReceivable}'
         AND COALESCE(o.customer_id, r.customer_id) IS NOT NULL
       GROUP BY COALESCE(o.customer_id, r.customer_id)
    )
    SELECT c.*,
           coalesce(os.order_count, 0)   AS order_count,
           coalesce(os.total_spent, 0)   AS total_spent,
           os.last_purchase_date,
           os.first_purchase_date,
           CASE WHEN coalesce(os.order_count, 0) > 0
                THEN coalesce(os.total_spent, 0) / os.order_count
                ELSE 0 END               AS average_order,
           coalesce(ps.loyalty_points, 0) AS loyalty_points,
           coalesce(ars.ar_balance, 0)   AS ar_balance
      FROM parties c
      LEFT JOIN order_stats os ON os.customer_id = c.id
      LEFT JOIN point_stats ps ON ps.customer_id = c.id
      LEFT JOIN ar_stats ars ON ars.customer_id = c.id
     WHERE c.business_id = $1
       AND c.roles && ARRAY['customer']::text[]
       AND c.is_active
       AND c.merged_into_id IS NULL
       AND c.roles && ARRAY['customer']::text[]
  `;
}

/** Columns the member list returns — one spelling, so preview and resolve match. */
const MEMBER_COLUMNS = `
  s.id, s.name, s.phone, s.phone_e164 AS "phoneE164", s.email, s.tags,
  s.sms_consent AS "smsConsent", s.marketing_consent AS "marketingConsent",
  s.is_active AS "isActive",
  s.last_purchase_date::text AS "lastPurchaseDate",
  s.order_count AS "orderCount",
  s.total_spent AS "totalSpentRial",
  s.lifecycle_stage AS "lifecycleStage"
`;

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return fallback;
  return Math.min(Math.floor(value), max);
}

/**
 * Build the full statement for a definition.
 *
 * `s` is the aggregate CTE and `c` is the customer row; both aliases are what
 * `FIELD_SQL` in `segments.ts` compiles against. They point at the same
 * relation here (the CTE selects `c.*`), which is what lets a rule mention a
 * raw customer column and an aggregate in the same breath.
 */
async function buildSegmentQuery(
  businessId: string,
  definition: SegmentDefinition,
  purpose: SegmentPurpose,
  options: { limit?: number; countOnly?: boolean; anchorDate?: string } = {},
): Promise<{ sql: string; params: unknown[] }> {
  const anchorDate = options.anchorDate ?? (await businessToday(businessId));
  // $1 is the business id, so the compiler's own parameters start at $2.
  const compiled = compileSegment(definition, { anchorDate, paramOffset: 1 });
  const params: unknown[] = [businessId, ...compiled.params];

  const consent = consentPredicate(purpose);
  const select = options.countOnly ? "count(*)::int AS count" : MEMBER_COLUMNS;
  const source = segmentSourceSql();

  let sql = `
    WITH scoped AS (${source})
    SELECT ${select}
      FROM scoped s
      JOIN parties c ON c.id = s.id
     WHERE (${compiled.sql}) AND (${consent})
  `;
  if (!options.countOnly) {
    sql += ` ORDER BY s.total_spent DESC, s.name`;
    if (options.limit !== undefined) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
  }
  return { sql, params };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const SEGMENT_COLUMNS = `id, name, description, definition,
  is_builtin AS "isBuiltin", archived_at AS "archivedAt",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function listSegments(
  businessId: string,
  options: { includeArchived?: boolean } = {},
): Promise<CustomerSegment[]> {
  const { rows } = await query<CustomerSegment>(
    `SELECT ${SEGMENT_COLUMNS} FROM customer_segments
      WHERE business_id = $1 ${options.includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY is_builtin, name`,
    [businessId],
  );
  return rows;
}

export async function getSegment(
  businessId: string,
  id: string,
): Promise<CustomerSegment | null> {
  const { rows } = await query<CustomerSegment>(
    `SELECT ${SEGMENT_COLUMNS} FROM customer_segments WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ?? null;
}

export interface CreateSegmentInput {
  name: string;
  description?: string;
  definition: SegmentDefinition;
  createdBy?: string;
  isBuiltin?: boolean;
}

export async function createSegment(
  businessId: string,
  input: CreateSegmentInput,
): Promise<CustomerSegment> {
  const problems = validateSegmentDefinition(input.definition);
  if (problems.length > 0) throw new Error(problems.join(" "));

  const { rows } = await query<CustomerSegment>(
    `INSERT INTO customer_segments (business_id, name, description, definition, is_builtin, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     RETURNING ${SEGMENT_COLUMNS}`,
    [
      businessId,
      input.name.trim(),
      input.description?.trim() ?? "",
      JSON.stringify(input.definition ?? {}),
      input.isBuiltin ?? false,
      input.createdBy ?? "",
    ],
  );
  return rows[0];
}

export interface UpdateSegmentInput {
  name?: string;
  description?: string;
  definition?: SegmentDefinition;
  archived?: boolean;
}

export async function updateSegment(
  businessId: string,
  id: string,
  input: UpdateSegmentInput,
): Promise<CustomerSegment | null> {
  if (input.definition !== undefined) {
    const problems = validateSegmentDefinition(input.definition);
    if (problems.length > 0) throw new Error(problems.join(" "));
  }

  const sets: string[] = [];
  const params: unknown[] = [businessId, id];
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    sets.push(fragment.replace("$n", `$${params.length}`));
  };

  if (input.name !== undefined) add("name = $n", input.name.trim());
  if (input.description !== undefined)
    add("description = $n", input.description.trim());
  if (input.definition !== undefined)
    add("definition = $n::jsonb", JSON.stringify(input.definition));
  if (input.archived !== undefined)
    add("archived_at = $n", input.archived ? new Date().toISOString() : null);
  if (sets.length === 0) return getSegment(businessId, id);

  const { rows } = await query<CustomerSegment>(
    `UPDATE customer_segments SET ${sets.join(", ")}, updated_at = now()
      WHERE business_id = $1 AND id = $2
      RETURNING ${SEGMENT_COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
}

/** Archives rather than deletes — a sent campaign must keep resolving its segment's name. */
export async function archiveSegment(
  businessId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await query(
    `UPDATE customer_segments SET archived_at = now(), updated_at = now()
      WHERE business_id = $1 AND id = $2 AND archived_at IS NULL`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Preview and resolution
// ---------------------------------------------------------------------------

export interface SegmentPreview {
  count: number;
  sample: SegmentMember[];
  /** How many the segment matches *before* consent narrowed it — the gap is the point. */
  totalBeforeConsent: number;
  purpose: SegmentPurpose;
}

/**
 * Count and sample a definition without saving it — what the builder shows
 * while the owner is still typing.
 *
 * `totalBeforeConsent` is returned alongside the consented count so the UI can
 * say «۱۲۰ نفر، ۴۵ نفر با اجازهٔ پیامک». Showing only the filtered number
 * would leave the owner wondering why their segment "shrank"; showing the gap
 * turns it into the useful fact that most of their customers have never been
 * asked for permission.
 */
export async function previewSegment(
  businessId: string,
  definition: SegmentDefinition,
  options: { purpose?: SegmentPurpose; sampleSize?: number } = {},
): Promise<SegmentPreview> {
  const purpose = options.purpose ?? "view";
  const anchorDate = await businessToday(businessId);

  const counted = await buildSegmentQuery(businessId, definition, purpose, {
    countOnly: true,
    anchorDate,
  });
  const { rows: countRows } = await query<{ count: number }>(
    counted.sql,
    counted.params,
  );

  // The unfiltered population, so the UI can show «۱۲۰ نفر، ۴۵ نفر با اجازهٔ
  // پیامک» rather than a silently smaller number. Skipped entirely when the
  // purpose is already `view`, where the two counts are the same query.
  let totalBeforeConsent = countRows[0]?.count ?? 0;
  if (purpose !== "view") {
    const unfiltered = await buildSegmentQuery(businessId, definition, "view", {
      countOnly: true,
      anchorDate,
    });
    const { rows } = await query<{ count: number }>(
      unfiltered.sql,
      unfiltered.params,
    );
    totalBeforeConsent = rows[0]?.count ?? 0;
  }

  const sampled = await buildSegmentQuery(businessId, definition, purpose, {
    limit: boundedPositiveInteger(options.sampleSize, 10, 50),
    anchorDate,
  });
  const { rows: sample } = await query<SegmentMember>(
    sampled.sql,
    sampled.params,
  );

  return {
    count: countRows[0]?.count ?? 0,
    totalBeforeConsent,
    sample,
    purpose,
  };
}

/**
 * Resolve a saved segment to its members.
 *
 * **This is the only function that produces an audience**, and `purpose` is
 * required. `purpose: "sms"` never returns a customer without `sms_consent`;
 * `purpose: "email"` never returns one without `marketing_consent` *and* an
 * email address. The filter is in the SQL, so it holds for every caller
 * including ones that do not exist yet.
 */
export async function resolveSegment(
  businessId: string,
  segmentId: string,
  options: { purpose: SegmentPurpose; limit?: number },
): Promise<SegmentMember[]> {
  const segment = await getSegment(businessId, segmentId);
  if (!segment) return [];
  return resolveDefinition(businessId, segment.definition, options);
}

/** The same, for an unsaved definition — the preview path and the AI's tool. */
export async function resolveDefinition(
  businessId: string,
  definition: SegmentDefinition,
  options: { purpose: SegmentPurpose; limit?: number },
): Promise<SegmentMember[]> {
  const built = await buildSegmentQuery(
    businessId,
    definition,
    options.purpose,
    {
      limit: boundedPositiveInteger(options.limit, 1000, 10_000),
    },
  );
  const { rows } = await query<SegmentMember>(built.sql, built.params);
  return rows;
}

/** Member count for an unsaved definition — used when counts must not be capped by the sample size. */
export async function countDefinition(
  businessId: string,
  definition: SegmentDefinition,
  purpose: SegmentPurpose = "view",
): Promise<number> {
  const built = await buildSegmentQuery(businessId, definition, purpose, {
    countOnly: true,
  });
  const { rows } = await query<{ count: number }>(built.sql, built.params);
  return rows[0]?.count ?? 0;
}

/** Member count for a saved segment — what the segment list shows next to each name. */
export async function countSegment(
  businessId: string,
  segmentId: string,
  purpose: SegmentPurpose = "view",
): Promise<number> {
  const segment = await getSegment(businessId, segmentId);
  if (!segment) return 0;
  return countDefinition(businessId, segment.definition, purpose);
}

/** Counts for every segment at once, so the list page is one round trip per segment rather than N+1 in the browser. */
export async function listSegmentsWithCounts(
  businessId: string,
): Promise<(CustomerSegment & { memberCount: number })[]> {
  const segments = await listSegments(businessId);
  const counts = await Promise.all(
    segments.map(async (segment) => {
      try {
        return await countDefinition(businessId, segment.definition, "view");
      } catch {
        // A stored definition that no longer compiles (a field removed in a
        // later version, say) must not take the whole page down with it — the
        // segment lists with an unknown count and can still be edited or
        // archived.
        return 0;
      }
    }),
  );
  return segments.map((segment, index) => ({
    ...segment,
    memberCount: counts[index],
  }));
}
