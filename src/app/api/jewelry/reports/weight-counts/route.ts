import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  listWeightCounts,
  recordWeightCount,
  weightReconciliation,
} from "@/lib/industry-reports-service";

/** تطبیق وزنی — what the books hold per purity, the latest count of each, and the count history. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ reconciliation: [], counts: [] });

  const [reconciliation, counts] = await Promise.all([
    weightReconciliation(location.id),
    listWeightCounts(location.id),
  ]);
  return NextResponse.json({ reconciliation, counts });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.reportsView);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  let body: { purity?: string; countedWeight?: string; countDate?: string; notes?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  try {
    const count = await recordWeightCount({
      locationId: location.id,
      purity: body.purity ?? "",
      countedWeight: String(body.countedWeight ?? ""),
      countDate: body.countDate,
      notes: body.notes ?? null,
      createdBy: session.sub,
    });
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
