import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getPool } from "@/lib/db";
import { payLayaway, JewelryFlagshipError } from "@/lib/jewelry-flagship-service";

export const POST = withTenantScope(async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const { id } = await ctx.params;
  let body: { amount?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await payLayaway(client, {
      businessId: session.businessId,
      planId: id,
      amount: Number(body.amount ?? 0),
      createdBy: session.sub,
    });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, plan });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof JewelryFlagshipError || err instanceof Error ? err.message : "پرداخت لیاوی ناموفق بود.";
    return NextResponse.json({ error: "pay_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
