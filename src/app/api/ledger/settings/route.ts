import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { postingRulesFor } from "@/lib/accounting-posting-rules";
import { INDUSTRY_LABELS, type Industry } from "@/lib/industries";
import type { CostingSetting } from "@/lib/setup-state";

/**
 * What «تنظیمات حسابداری» is actually configured to do right now.
 *
 * The settings page used to be four static cards — two links and two «به‌زودی»
 * placeholders — so it could not answer the questions an accountant opens it
 * to ask: what VAT rate is this ledger applying, is a fiscal year even
 * defined, how many accounts are in the chart, and which accounts does a sale
 * post to. Every one of those facts already existed; none of them was on the
 * screen.
 *
 * Read-only on purpose. The editable surfaces live where they are owned — the
 * chart of accounts and the fiscal periods each have a full screen, and the
 * business VAT rate is a platform setting (`/settings/tax`) shared with the
 * till. This route reports the state and the page links to the owner of each,
 * rather than forking a second editor over one table.
 *
 * Owner/manager/accountant, the app's own door — the same line every
 * `/api/ledger/*` read draws. The `ledger` feature flag is enforced for the
 * whole prefix by `withTenantScope`.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const businessId = session.businessId;

  /**
   * One round trip each, in parallel, and every one of them degrades to a
   * null/zero rather than failing the page: a settings screen that 500s
   * because one count query is slow is worse than one that renders the four
   * facts it did get. The page distinguishes "not configured" from "unknown"
   * by the shape of what comes back.
   */
  const [industryRow, taxSetting, costingSetting, accountCounts, fiscalState] = await Promise.all([
    query<{ industry: Industry }>("SELECT industry FROM businesses WHERE id = $1", [businessId]),
    getSetting<{ defaultRate: number }>(businessId, SETTING_KEYS.tax),
    getSetting<CostingSetting>(businessId, SETTING_KEYS.costing),
    query<{ total: string; active: string; archived: string }>(
      `SELECT count(*)::text                                    AS total,
              count(*) FILTER (WHERE is_active)::text           AS active,
              count(*) FILTER (WHERE NOT is_active)::text       AS archived
         FROM accounts WHERE business_id = $1`,
      [businessId],
    ),
    query<{
      year_count: string;
      current_year_label: string | null;
      open_periods: string;
      soft_closed_periods: string;
      locked_periods: string;
    }>(
      /*
       * The *current* fiscal year is the one today falls inside — not simply
       * the newest row. A business that has defined next year in advance would
       * otherwise be told its periods are the ones nobody is posting into yet.
       * `LEFT JOIN` on the same predicate keeps the period tallies scoped to
       * that year while still answering when no year contains today.
       */
      `WITH current_year AS (
         SELECT id, label FROM fiscal_years
          WHERE business_id = $1 AND current_date BETWEEN starts_on AND ends_on
          ORDER BY starts_on DESC LIMIT 1
       )
       SELECT (SELECT count(*) FROM fiscal_years WHERE business_id = $1)::text AS year_count,
              (SELECT label FROM current_year)                                 AS current_year_label,
              count(*) FILTER (WHERE fp.status = 'open')::text                 AS open_periods,
              count(*) FILTER (WHERE fp.status = 'soft_closed')::text          AS soft_closed_periods,
              count(*) FILTER (WHERE fp.status = 'locked')::text               AS locked_periods
         FROM current_year cy
         LEFT JOIN fiscal_periods fp
                ON fp.fiscal_year_id = cy.id AND fp.business_id = $1`,
      [businessId],
    ),
  ]);

  const industry = industryRow.rows[0]?.industry ?? "food_service";
  const counts = accountCounts.rows[0];
  const fiscal = fiscalState.rows[0];
  const inventorySystem = costingSetting?.system ?? "perpetual";

  return NextResponse.json({
    settings: {
      industry,
      industryLabel: INDUSTRY_LABELS[industry],
      /**
       * `null` means "never configured", which the page says out loud — it is
       * a different fact from a deliberate zero rate, and an accountant has to
       * be able to tell them apart.
       */
      vatRate: typeof taxSetting?.defaultRate === "number" ? taxSetting.defaultRate : null,
      inventorySystem,
      costingMethod: costingSetting?.method ?? null,
      accounts: {
        total: Number(counts?.total ?? 0),
        active: Number(counts?.active ?? 0),
        archived: Number(counts?.archived ?? 0),
      },
      fiscal: {
        yearCount: Number(fiscal?.year_count ?? 0),
        currentYearLabel: fiscal?.current_year_label ?? null,
        openPeriods: Number(fiscal?.open_periods ?? 0),
        softClosedPeriods: Number(fiscal?.soft_closed_periods ?? 0),
        lockedPeriods: Number(fiscal?.locked_periods ?? 0),
      },
      postingRules: postingRulesFor({ industry, inventorySystem }),
    },
  });
});
