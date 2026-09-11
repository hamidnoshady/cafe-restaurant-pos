import { NextRequest, NextResponse } from "next/server";

import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { isSyncKind } from "@/lib/cms/platform-control";
import { listCmsSyncRuns, listMirroredCmsSites } from "@/lib/cms/platform-control-service";
import {
  runCmsEventShipping,
  runCmsMirror,
  runCmsPull,
  runCmsPush,
} from "@/lib/cms/platform-sync";

/**
 * «سایت‌ساز ← همگام‌سازی» — the four sync operations, on demand.
 *
 * One route with a `kind` rather than four, because they share everything that
 * matters: the same credential, the same run log, the same audit shape, and the
 * same rule that a failure is an answer with a code in it rather than a 500. The
 * four are `mirror`, `events`, `pull` and `push` (see `platform-sync.ts`).
 *
 * `push` is the only one that changes a customer's site, and it carries two safety
 * properties worth naming here rather than only in the service:
 *
 *  - **A dry run is the default answer to a new snapshot.** The console runs
 *    `dryRun: true` first and shows the plan — «۴ به‌روزرسانی، ۱ ساخت» — because a
 *    count that only appears after the write is not a decision.
 *  - **The counts reported are the CMS's, not ours.** A write is applied only to the
 *    extent the other side says it was, which is why the run row is filled from the
 *    import result and not from the snapshot that was sent.
 *
 * All four need `cms.manage`: even `mirror`, which only reads, spends the platform
 * credential and writes to this deployment's own tables.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("cms.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = body.kind;
  if (!isSyncKind(kind)) return NextResponse.json({ error: "invalid_kind" }, { status: 400 });

  const context = {
    actor: session.padmin,
    startedBy: session.padmin,
    trigger: "manual" as const,
  };
  const collections = Array.isArray(body.collections)
    ? body.collections.filter((name): name is string => typeof name === "string")
    : undefined;
  const siteId = typeof body.siteId === "string" ? body.siteId.trim() : "";

  const audit = async (payload: Record<string, unknown>) =>
    platformAudit({
      action: `platform_cms.sync.${kind}`,
      adminId: session.padmin,
      entity: "platform_cms_sync_runs",
      entityId: siteId || null,
      ipAddress: clientIpFrom(request.headers, 0),
      payload,
      userAgent: request.headers.get("user-agent"),
    });

  if (kind === "mirror") {
    const result = await runCmsMirror(context);
    await audit({ ok: result.ok, sites: result.sites });
    return NextResponse.json(
      { result, runs: await listCmsSyncRuns(10), sites: await listMirroredCmsSites() },
      { status: result.ok ? 200 : 502 },
    );
  }

  if (kind === "events") {
    const result = await runCmsEventShipping(context);
    await audit({ ok: result.ok, shipped: result.shipped });
    return NextResponse.json(
      { result, runs: await listCmsSyncRuns(10) },
      { status: result.ok ? 200 : 502 },
    );
  }

  if (!siteId) return NextResponse.json({ error: "site_required" }, { status: 400 });

  if (kind === "pull") {
    const result = await runCmsPull(siteId, { collections }, context);
    await audit({ collections: collections ?? null, ok: result.ok, siteId });
    return NextResponse.json(
      { result, runs: await listCmsSyncRuns(10) },
      { status: result.ok ? 200 : 502 },
    );
  }

  // push
  if (!body.snapshot || typeof body.snapshot !== "object") {
    return NextResponse.json({ error: "snapshot_required" }, { status: 400 });
  }
  const dryRun = body.dryRun !== false; // opt *out* of the plan, never into it
  const result = await runCmsPush(
    siteId,
    { collections, dryRun, force: body.force === true, snapshot: body.snapshot },
    context,
  );
  await audit({
    collections: collections ?? null,
    dryRun,
    force: body.force === true,
    ok: result.ok,
    siteId,
    summary: result.result?.summary ?? null,
  });
  return NextResponse.json(
    { result, runs: await listCmsSyncRuns(10) },
    { status: result.ok ? 200 : 502 },
  );
});
