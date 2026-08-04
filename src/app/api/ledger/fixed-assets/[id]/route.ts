import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { FixedAssetError, deleteFixedAsset } from "@/lib/fixed-assets-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** Hard delete — only ever succeeds for an asset with no depreciation posted yet. */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const { id } = await ctx.params;
  try {
    await deleteFixedAsset(session.businessId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof FixedAssetError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
