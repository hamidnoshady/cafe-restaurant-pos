import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { PLATFORM_RESTORE_CONFIRM_PHRASE, resolveRestorePlan } from "@/lib/platform-backup";
import {
  getPlatformBackupConfig,
  knownPeerIds,
  restorePlatformFromPlan,
} from "@/lib/platform-backup-service";

/**
 * Restore this server's entire database from an artifact — the console's twin of
 * `npm run db:restore`, but able to pull the artifact from another machine by
 * address instead of from a laptop with a dump file on it.
 *
 * Two modes, and the difference between them is the whole point of the design:
 *
 *   verify (`apply` false or absent) — download, decrypt, restore into a
 *     throwaway database, validate, report. Non-destructive; needs
 *     `backup.manage`, so an engineer can prove a backup is good.
 *
 *   apply (`apply: true`) — after re-verifying, drop and recreate the
 *     production database from those same bytes. Needs `backup.restore`
 *     (owner only) *and* the confirmation phrase, which is checked by the pure
 *     resolver before any byte moves.
 *
 * The phrase is required per request rather than "session already confirmed":
 * the two clicks that matter are minutes apart and the second one is the
 * destructive one, so the confirmation belongs to the destructive act.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const wantsApply = body.apply === true;

  const guard = await requirePlatformCapability(wantsApply ? "backup.restore" : "backup.manage");
  if (guard.error) return guard.error;
  const { session } = guard;

  const config = await getPlatformBackupConfig();
  const plan = resolveRestorePlan(body, {
    allowInsecurePeers: config.allowInsecurePeers,
    knownPeerIds: await knownPeerIds(),
  });
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  const outcome = await restorePlatformFromPlan(plan, session.padmin);
  if (outcome.status === "failed") {
    // The reason is operator-facing (a passphrase, a checksum, an unreachable
    // address), so it travels in `detail` as well as the log line.
    return NextResponse.json(
      { error: "restore_failed", detail: outcome.error.slice(0, 300) },
      { status: 400 },
    );
  }

  await platformAudit({
    adminId: session.padmin,
    action: wantsApply ? "platform_backup.restore.apply" : "platform_backup.restore.verify",
    entity: "platform_restore_runs",
    payload: {
      source: plan.source,
      peerId: plan.peerId,
      artifact: plan.artifact,
      status: outcome.status,
      migrations: outcome.summary.migrations,
      latestMigration: outcome.summary.latestMigration,
      tables: outcome.summary.tables,
      warnings: "warnings" in outcome ? outcome.warnings : [],
    },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json(outcome);
});

/** The phrase the UI must make the operator type — read from the same module the check uses. */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("backup.manage");
  if (error) return error;
  return NextResponse.json({ confirmPhrase: PLATFORM_RESTORE_CONFIRM_PHRASE });
});
