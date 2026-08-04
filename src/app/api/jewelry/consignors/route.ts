import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { createConsignor, listConsignors } from "@/lib/consignment-service";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const consignors = await listConsignors(session.businessId);
  return NextResponse.json({ consignors });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  let body: { name?: string; phone?: string | null; notes?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const consignor = await createConsignor(session.businessId, {
      name: body.name ?? "",
      phone: body.phone ?? null,
      notes: body.notes ?? null,
    });
    return NextResponse.json({ ok: true, consignor });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
