import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { REPORT_VIEWS } from "@/lib/reports";

/** The view whitelist (dimensions/metrics/filters), for the custom report builder's source/metric/dimension pickers. */
export async function GET() {
  const { error } = await requireRole("owner", "manager");
  if (error) return error;

  const views = Object.entries(REPORT_VIEWS).map(([key, view]) => ({
    key,
    label: view.label,
    hasDateColumn: view.dateColumn !== null,
    dimensions: view.dimensions.map((d) => ({ key: d.key, label: d.label })),
    metrics: view.metrics.map((m) => ({ key: m.key, label: m.label, aggregations: m.aggregations })),
    filters: view.filters?.map((f) => ({ key: f.key, label: f.label })) ?? [],
  }));
  return NextResponse.json({ views });
}
