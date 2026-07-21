import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { validateReportConfig, type ReportConfig } from "@/lib/reports";
import { createSavedReport, ensureStandardSavedReports, listSavedReports } from "@/lib/reports-service";

/** Saved reports (standard + custom), for the "پیام‌های ذخیره‌شده" list and dashboard-widget picker. */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  await ensureStandardSavedReports(session.businessId);
  const reports = await listSavedReports(session.businessId);
  return NextResponse.json({ reports });
}

/** Saves a custom report built in the report builder. */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: string; config?: ReportConfig };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (!body.config) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const errors = validateReportConfig(body.config);
  if (errors.length > 0) return NextResponse.json({ error: "invalid_config", details: errors }, { status: 400 });

  const id = await createSavedReport(session.businessId, session.sub, name, body.config);
  return NextResponse.json({ ok: true, id });
}
