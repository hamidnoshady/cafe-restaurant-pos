import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { listLayaways } from "@/lib/jewelry-flagship-service";

/** دفتر لیاوی — the branch's open plans and outstanding Rial, plus the full plan list. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rows: [], book: null });

  const { rows, book } = await listLayaways(session.businessId, location.id);
  return NextResponse.json({ rows, book });
});
