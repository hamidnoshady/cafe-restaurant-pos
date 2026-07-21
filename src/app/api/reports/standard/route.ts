import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { STANDARD_REPORTS } from "@/lib/reports";

/** The pre-built report library — key/label list for the standard-reports UI. */
export async function GET() {
  const { error } = await requireRole("owner", "manager");
  if (error) return error;

  const reports = STANDARD_REPORTS.map((r) => ({
    key: r.key,
    label: r.label,
    chartType: r.defaultChart?.chartType ?? null,
  }));
  return NextResponse.json({ reports });
}
