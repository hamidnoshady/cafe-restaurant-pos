import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getBackupHealth, listBackupRuns } from "@/lib/backup-service";

/** Backup health + recent run history for the dashboard. Owner/Manager. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.backupManage);
  if (error) return error;

  const [health, runs] = await Promise.all([
    getBackupHealth(session.businessId),
    listBackupRuns(session.businessId),
  ]);
  return NextResponse.json({ health, runs });
});
