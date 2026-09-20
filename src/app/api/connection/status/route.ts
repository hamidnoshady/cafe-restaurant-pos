import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { deploymentRole } from "@/lib/deployment-role";
import { getServerSyncConfig, getServerSyncState } from "@/lib/server-sync";

/**
 * Small authenticated status model for every operational screen. It returns no
 * token or business payload; it only distinguishes the local server from the
 * optional outbound cloud channel so an Internet outage is not presented as a
 * POS outage.
 */
export const dynamic = "force-dynamic";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant", "cashier", "waiter", "kitchen");
  if (error) return error;

  if (deploymentRole() !== "site") {
    return NextResponse.json({ cloudSync: "not_applicable", lastSuccessAt: null, error: null });
  }
  const [config, state] = await Promise.all([
    getServerSyncConfig(session.businessId),
    getServerSyncState(session.businessId),
  ]);
  if (!config?.enabled) {
    return NextResponse.json({ cloudSync: "not_configured", lastSuccessAt: null, error: null });
  }
  const lastSuccessAt = [state.lastPushSuccessAt, state.lastPullSuccessAt].filter(Boolean).sort().at(-1) ?? null;
  const errorText = state.lastPushError || state.lastPullError;
  return NextResponse.json({
    cloudSync: errorText ? "paused" : lastSuccessAt ? "connected" : "connecting",
    lastSuccessAt,
    // Deliberately classify rather than returning provider URLs/errors, which
    // may include credentials or customer-specific hostnames.
    error: errorText ? "remote_unreachable" : null,
  });
});
