import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import { nearExpiryBatches } from "@/lib/cosmetics-service";

/** فهرست بچ‌های منقضی و نزدیک به انقضا — the list the cosmetics home page surfaces. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "cosmetics");
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ rows: [] });

  const rows = await nearExpiryBatches(location.id);
  return NextResponse.json({ rows });
});
