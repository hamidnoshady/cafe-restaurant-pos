import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { serviceReminders } from "@/lib/watch-crm-service";

/** The due-for-service list for the caller's branch — sold units whose next service (sale date + model interval) is due or overdue. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "watch");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ reminders: [] });

  const leadDays = Number(request.nextUrl.searchParams.get("leadDays") ?? 30);
  const todayIso = new Date().toISOString().slice(0, 10);
  const reminders = await serviceReminders(location.id, todayIso, Number.isFinite(leadDays) ? leadDays : 30);
  return NextResponse.json({ reminders });
});
