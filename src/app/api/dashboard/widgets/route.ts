import { NextRequest, NextResponse } from "next/server";
import { requireRole, type Role } from "@/lib/auth";
import { getDashboardWidgets, saveDashboardWidgets, type WidgetInput } from "@/lib/reports-service";

const ROLES: Role[] = ["owner", "manager", "cashier", "waiter", "kitchen"];

/** The caller's dashboard widget layout: their personal one if they have one, else their role's default. Every role can view — only Owner/Manager can edit (see POST). */
export async function GET() {
  const { session, error } = await requireRole(...ROLES);
  if (error) return error;

  const result = await getDashboardWidgets(session.businessId, session.sub, session.role);
  return NextResponse.json(result);
}

interface WidgetBody {
  scope?: "personal" | "role";
  role?: Role;
  widgets?: WidgetInput[];
}

/** Replaces a whole widget layout — the caller's own, or (owner/manager only) a role's default. Dashboard customization is an Owner/Manager feature, same as the rest of reporting. */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: WidgetBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const widgets = (body.widgets ?? []).map((w) => ({
    savedReportId: String(w.savedReportId ?? ""),
    chartType: w.chartType,
    title: w.title ?? null,
    x: Number(w.x) || 0,
    y: Number(w.y) || 0,
    w: Number(w.w) || 4,
    h: Number(w.h) || 3,
  }));
  for (const w of widgets) {
    if (!w.savedReportId || !["line", "bar", "pie", "number"].includes(w.chartType)) {
      return NextResponse.json({ error: "invalid_widget" }, { status: 400 });
    }
  }

  if (body.scope === "role") {
    if (!body.role || !ROLES.includes(body.role)) {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    }
    await saveDashboardWidgets(session.businessId, { role: body.role }, widgets);
  } else {
    await saveDashboardWidgets(session.businessId, { userId: session.sub }, widgets);
  }
  return NextResponse.json({ ok: true });
}
