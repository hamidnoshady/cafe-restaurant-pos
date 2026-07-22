/**
 * Server-side executors for the assistant's read-only tools. These run with the
 * caller's business scope and never mutate data — mutations always go through the
 * confirmed-action flow (propose_action → human "Apply" → existing API endpoint).
 */
import { STANDARD_REPORTS } from "./reports";
import {
  getBalanceSheet,
  getProfitAndLoss,
  runStandardReportRows,
} from "./reports-service";
import { computeSetupState } from "./setup-state";

export interface ToolResult {
  ok: boolean;
  data: unknown;
}

/** Cap rows/size so a big report can't blow the model's context window. */
function cap<T>(rows: T[], limit = 50): T[] {
  return rows.slice(0, limit);
}

export async function runReadTool(
  name: string,
  args: Record<string, unknown>,
  businessId: string,
): Promise<ToolResult> {
  switch (name) {
    case "get_setup_state": {
      const state = await computeSetupState(businessId);
      // Trim to what the model needs — drop nothing important but keep it compact.
      return {
        ok: true,
        data: {
          business: state.business,
          location: state.location,
          prefs: state.prefs,
          costing: state.costing,
          tax: state.tax,
          counts: state.counts,
          completedSteps: Object.keys(state.progress.steps),
          completedAt: state.progress.completedAt,
          missingForCompletion: state.missingForCompletion,
        },
      };
    }

    case "list_reports": {
      return {
        ok: true,
        data: STANDARD_REPORTS.map((r) => ({ key: r.key, label: r.label })),
      };
    }

    case "run_report": {
      const key = typeof args.key === "string" ? args.key : "";
      const def = STANDARD_REPORTS.find((r) => r.key === key);
      if (!def) {
        return {
          ok: false,
          data: {
            error: "کلید گزارش نامعتبر است. اول list_reports را صدا بزن.",
            validKeys: STANDARD_REPORTS.map((r) => r.key),
          },
        };
      }
      const dateFrom = typeof args.dateFrom === "string" ? args.dateFrom : undefined;
      const dateTo = typeof args.dateTo === "string" ? args.dateTo : undefined;

      if (key === "profit_and_loss") {
        return { ok: true, data: await getProfitAndLoss(businessId, { dateFrom, dateTo }) };
      }
      if (key === "balance_sheet") {
        return { ok: true, data: await getBalanceSheet(businessId, dateTo) };
      }
      const rows = await runStandardReportRows(key, businessId, { dateFrom, dateTo });
      return { ok: true, data: { label: def.label, rowCount: rows.length, rows: cap(rows) } };
    }

    default:
      return { ok: false, data: { error: `ابزار ناشناخته: ${name}` } };
  }
}

export const READ_TOOL_NAMES = new Set(["get_setup_state", "list_reports", "run_report"]);
