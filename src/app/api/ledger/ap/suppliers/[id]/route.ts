import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getSupplierStatement } from "@/lib/ap-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** One supplier's full AP activity (bills + payments + returns) with a running balance. `id` may be "unknown" for unattributed lines. */
export const GET = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { id } = await ctx.params;
  return NextResponse.json({ lines: await getSupplierStatement(session.businessId, id) });
});
