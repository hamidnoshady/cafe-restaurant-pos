import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireIndustryForApi } from "@/lib/industry-guard";
import { getPool } from "@/lib/db";
import { completeLayaway, JewelryFlagshipError } from "@/lib/jewelry-flagship-service";

export const POST = withTenantScope(async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.inventoryAdjust);
  if (error) return error;
  const industryError = await requireIndustryForApi(session, "jewelry");
  if (industryError) return industryError;

  const { id } = await ctx.params;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const plan = await completeLayaway(client, { businessId: session.businessId, planId: id, createdBy: session.sub });
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, plan });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = err instanceof JewelryFlagshipError || err instanceof Error ? err.message : "تکمیل لیاوی ناموفق بود.";
    return NextResponse.json({ error: "complete_failed", message }, { status: 400 });
  } finally {
    client.release();
  }
});
