/**
 * Customer CSV export — «خروجی گرفتن از مشتریان».
 *
 * ## Export is a privacy event, not a download
 *
 * A customer export is the whole directory — names, phones, emails, spend —
 * leaving the system in a form nobody can recall. So every export is audited
 * with who, when, how many rows and which filters, and the route behind it
 * requires the dedicated `crm.export` permission rather than plain view
 * access. Reading one customer's file and downloading all of them are
 * different acts, and the permission model says so.
 *
 * ## What is deliberately not exported
 *
 * No consent flags and no marketing opt-in state. Consent is not portable: it
 * was granted to this business through a recorded channel, and a column of
 * `true` in a spreadsheet is exactly how it gets imported somewhere it was
 * never granted. Anyone who needs the consent position has the consent ledger,
 * which carries the source and timestamp that make it meaningful.
 *
 * Money is exported in Rial, unformatted, because the file is for machines and
 * accountants. Dates go out as Jalali for humans plus ISO for tooling.
 */

import { query } from "./db";
import { toCsv } from "./crm-csv";
import { recordCrmAudit } from "./crm-audit-service";
import { getSegment, resolveDefinition } from "./crm-segments-service";
import { formatJalali } from "./jalali";

export interface ExportFilters {
  segmentId?: string | null;
  tag?: string | null;
  lifecycle?: string | null;
  /** Hard ceiling regardless of what the caller asks for. */
  limit?: number;
}

const MAX_EXPORT_ROWS = 50_000;

const HEADERS = [
  "نام",
  "تلفن",
  "ایمیل",
  "وضعیت چرخهٔ عمر",
  "منبع آشنایی",
  "تعداد خرید",
  "مجموع خرید (ریال)",
  "آخرین خرید",
  "آخرین خرید (ISO)",
  "امتیاز RFM",
  "برچسب‌ها",
] as const;

interface ExportRow extends Record<string, unknown> {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  lifecycleStage: string | null;
  source: string | null;
  orderCount: number;
  totalSpentRial: string;
  lastPurchaseDate: string | null;
  rfm: string | null;
  tags: string[] | null;
}

/**
 * Build the CSV and record that it happened.
 *
 * Returns the text rather than a Response so the route stays a thin adapter
 * and the whole thing is testable without HTTP.
 *
 * Spend, order count and last-purchase date come from the segment engine's
 * aggregate CTE, not from a query written here. Those numbers are the ones
 * that already reconcile with the sales reports — business-day dated,
 * completed orders only, merged records excluded — and an exporter that
 * recomputed them its own way would eventually hand somebody a spreadsheet
 * that disagrees with the screen they exported it from.
 */
export async function exportCustomersCsv(
  businessId: string,
  filters: ExportFilters,
  actor: { name: string; userId?: string | null },
): Promise<{ csv: string; rowCount: number }> {
  const limit = Math.min(Math.max(filters.limit ?? MAX_EXPORT_ROWS, 1), MAX_EXPORT_ROWS);

  // `view` purpose: an export is somebody reading their own customer list, not
  // a send, so it is not filtered down to the marketing-consented subset. The
  // consent *columns* are what stays out of the file.
  let ids: string[] | null = null;
  if (filters.segmentId) {
    const segment = await getSegment(businessId, filters.segmentId);
    if (!segment) return { csv: toCsv(HEADERS, []), rowCount: 0 };
    const members = await resolveDefinition(businessId, segment.definition, {
      purpose: "view",
      limit,
    });
    ids = members.map((m) => m.id);
    if (ids.length === 0) return { csv: toCsv(HEADERS, []), rowCount: 0 };
  }

  const where: string[] = [
    "p.business_id = $1",
    "p.merged_into_id IS NULL",
    "p.is_active",
    "p.roles && ARRAY['customer']::text[]",
  ];
  const params: unknown[] = [businessId];
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    return fragment.replace("$n", `$${params.length}`);
  };

  if (ids) where.push(add("p.id = ANY($n::uuid[])", ids));
  if (filters.tag) where.push(add("$n = ANY(p.tags)", filters.tag));
  if (filters.lifecycle) where.push(add("p.lifecycle_stage = $n", filters.lifecycle));

  params.push(limit);
  const { rows } = await query<ExportRow>(
    `WITH order_stats AS (
       SELECT o.customer_id,
              count(*)::int                     AS order_count,
              coalesce(sum(o.total), 0)::bigint AS total_spent,
              max(app_business_date(o.closed_at, l.timezone, l.business_day_start_minutes))
                                                AS last_purchase_date
         FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE l.business_id = $1
          AND o.status = 'completed'
          AND o.closed_at IS NOT NULL
          AND o.customer_id IS NOT NULL
        GROUP BY o.customer_id
     )
     SELECT p.id,
            p.name,
            p.phone,
            p.email,
            p.lifecycle_stage AS "lifecycleStage",
            p.acquisition_source AS "source",
            coalesce(os.order_count, 0) AS "orderCount",
            coalesce(os.total_spent, 0)::text AS "totalSpentRial",
            os.last_purchase_date::text AS "lastPurchaseDate",
            CASE WHEN p.rfm_scored_at IS NULL THEN NULL
                 ELSE concat(p.rfm_recency, '-', p.rfm_frequency, '-', p.rfm_monetary)
            END AS "rfm",
            p.tags
       FROM parties p
       LEFT JOIN order_stats os ON os.customer_id = p.id
      WHERE ${where.join(" AND ")}
      ORDER BY p.name
      LIMIT $${params.length}`,
    params,
  );

  const csv = toCsv(
    HEADERS,
    rows.map((row) => [
      row.name,
      row.phone ?? "",
      row.email ?? "",
      row.lifecycleStage ?? "",
      row.source ?? "",
      row.orderCount,
      row.totalSpentRial,
      // Jalali for the person reading it, ISO alongside for whatever consumes
      // it next. Exporting only Jalali makes the file unparseable by tools;
      // only ISO makes it unreadable by its actual audience.
      row.lastPurchaseDate ? formatJalali(row.lastPurchaseDate) : "",
      row.lastPurchaseDate ?? "",
      row.rfm ?? "",
      (row.tags ?? []).join(" | "),
    ]),
  );

  await recordCrmAudit({
    businessId,
    kind: "export.generated",
    entityType: "export",
    entityId: null,
    partyId: null,
    summary: `خروجی مشتریان: ${rows.length} سطر`,
    detail: {
      rowCount: rows.length,
      filters: {
        segmentId: filters.segmentId ?? null,
        tag: filters.tag ?? null,
        lifecycle: filters.lifecycle ?? null,
      },
      // Stated explicitly so an auditor reading the log can see consent state
      // never left the building, without having to go read this file.
      consentExported: false,
    },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });

  return { csv, rowCount: rows.length };
}
