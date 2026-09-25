import { NextResponse } from "next/server";
import { withTenantScope, requireMember } from "@/lib/auth";
import { deploymentRole } from "@/lib/deployment-role";
import { readDeploymentProfile } from "@/lib/deployment-mode";
import { getServerSyncConfig, getServerSyncState } from "@/lib/server-sync";
import { query } from "@/lib/db";
import type { ConnectionStatus, PlatformConnectionState } from "@/lib/connection-state";

/**
 * Authenticated, credential-free connection model shared by the global status
 * indicator and Cloud & Sync center. It deliberately answers six independent
 * questions; local-server health is never inferred from Internet health.
 */
export const dynamic = "force-dynamic";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireMember();
  if (error) return error;

  const role = deploymentRole();
  const deployment = await readDeploymentProfile(session.businessId, role);
  if (role !== "site" || deployment.profile === "cloud") {
    const state: PlatformConnectionState = {
      localServer: "not_applicable",
      lanGateway: "not_applicable",
      internet: "connected",
      cloud: "connected",
      sync: "not_applicable",
      externalServices: "unknown",
      outboundPending: 0,
      inboundPending: 0,
      conflicts: 0,
      deadLetters: 0,
      lastSuccessfulSyncAt: null,
    };
    return NextResponse.json({ profile: deployment.profile, ...state, cloudSync: "not_applicable", error: null });
  }

  if (deployment.profile === "local") {
    const state: PlatformConnectionState = {
      localServer: "connected",
      lanGateway: "unknown",
      internet: "unknown",
      cloud: "not_configured",
      sync: "not_configured",
      externalServices: "not_configured",
      outboundPending: 0,
      inboundPending: 0,
      conflicts: 0,
      deadLetters: 0,
      lastSuccessfulSyncAt: null,
    };
    return NextResponse.json({ profile: "local", ...state, cloudSync: "not_configured", error: null });
  }

  const syncState = await getServerSyncState(session.businessId);
  const [config, counters] = await Promise.all([
    getServerSyncConfig(session.businessId),
    query<{ outbound: string; inbound: string; conflicts: string; dead_letters: string }>(
      `SELECT
         count(*) FILTER (WHERE se.origin='local')::text AS outbound,
         count(*) FILTER (WHERE se.origin='remote' AND se.applied_at IS NULL)::text AS inbound,
         (SELECT count(*) FROM sync_domain_effects WHERE business_id=$1 AND status='deferred')::text AS conflicts,
         (SELECT count(*) FROM sync_event_dead_letters WHERE business_id=$1 AND status='open')::text AS dead_letters
       FROM sync_events se
       JOIN locations l ON l.id=se.location_id
       WHERE l.business_id=$1
         AND EXISTS (SELECT 1 FROM users u WHERE u.id=$3 AND u.business_id=$1 AND u.is_active)
         AND (se.origin='remote' AND se.applied_at IS NULL
              OR se.origin='local' AND se.id > $2)`,
      [session.businessId, syncStateLastPushed(syncState), session.sub],
    ),
  ]);
  const row = counters.rows[0];
  const lastSuccessfulSyncAt = [syncState.lastPushSuccessAt, syncState.lastPullSuccessAt]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const errorText = syncState.lastPushError || syncState.lastPullError;
  const configured = Boolean(config?.enabled);
  const sync: ConnectionStatus = !configured
    ? "not_configured"
    : errorText
      ? "paused"
      : lastSuccessfulSyncAt
        ? "connected"
        : "connecting";
  const cloud: ConnectionStatus = !configured ? "not_configured" : errorText ? "unreachable" : lastSuccessfulSyncAt ? "connected" : "connecting";
  const state: PlatformConnectionState = {
    localServer: "connected",
    lanGateway: "unknown",
    internet: errorText ? "unknown" : cloud === "connected" ? "connected" : "unknown",
    cloud,
    sync,
    externalServices: cloud,
    outboundPending: Number(row?.outbound ?? 0),
    inboundPending: Number(row?.inbound ?? 0),
    conflicts: Number(row?.conflicts ?? 0),
    deadLetters: Number(row?.dead_letters ?? 0),
    lastSuccessfulSyncAt,
  };
  return NextResponse.json({
    profile: deployment.profile,
    ...state,
    // Compatibility field for the bounded IndexedDB queue hook.
    cloudSync: sync === "connected" ? "connected" : sync === "connecting" ? "connecting" : sync === "paused" ? "paused" : "not_configured",
    error: errorText ? "remote_unreachable" : null,
  });
});

function syncStateLastPushed(state: { lastPushedEventId?: number | null }): number {
  return Number.isSafeInteger(state.lastPushedEventId) ? Number(state.lastPushedEventId) : 0;
}
