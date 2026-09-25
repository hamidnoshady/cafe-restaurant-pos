import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { runRollupPush } from "@/lib/rollup-service";

/** "Sync now": one immediate push attempt, same code path as the timer tick. */
export const POST = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.rollupManage);
  if (error) return error;

  const result = await runRollupPush(session.businessId);
  return NextResponse.json({ result });
});
