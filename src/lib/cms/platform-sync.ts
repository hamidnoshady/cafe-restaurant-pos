/**
 * Syncing with the website platform — the four operations, in one place.
 *
 *   `mirror` — pull the CMS's site list into `platform_cms_sites`, so the console
 *              renders a fleet report from one local query and keeps rendering it
 *              when the CMS is unreachable.
 *   `events` — poll the CMS's own event tail on a cursor and ship it to
 *              OpenObserve, which is what makes «پایش سایت‌ساز» possible without
 *              putting a collector credential on the CMS.
 *   `pull`   — export one site's content out of the CMS.
 *   `push`   — apply a snapshot back into it (with a dry run first).
 *
 * Every one of them records a `platform_cms_sync_runs` row, success or failure,
 * with what it touched and how long it took. That is the whole difference between
 * an operation and an incident: a content restore nobody can point at afterwards
 * is the latter.
 *
 * Three rules hold here:
 *
 *  - **A failure is recorded, never thrown at a tick.** `runCmsControlTick` is
 *    called from `server.ts`, where an unhandled rejection would take the process
 *    with it. Each operation returns a typed result and writes its own log row;
 *    the console shows the last error, the tick moves on.
 *  - **The cursor advances to what was received, never to `now`.** A CMS record
 *    written while the poll was in flight must still be reachable on the next
 *    poll, so the cursor is the newest `at` in the page and the shipper tolerates
 *    the resulting overlap (records carry a stable `cms_event_id`).
 *  - **A push is never reported as applied unless the CMS answered 2xx.** The
 *    counts in the run row come from the CMS's own plan, not from what we sent.
 */
import { CmsApiError, CmsNetworkError, type CmsConfig } from "./client";
import { cmsObservabilityEnabled, logCmsFeedEvents } from "./observability";
import {
  exportCmsSnapshot,
  fetchAllCmsSites,
  fetchCmsEvents,
  importCmsSnapshot,
  type CmsImportResult,
  type CmsSnapshot,
} from "./platform-client";
import { mirrorIsDue, type CmsControlConfig } from "./platform-control";
import {
  advanceCmsEventsCursor,
  getCmsControlConfig,
  recordCmsSyncRun,
  recordEventsFailure,
  recordMirrorFailure,
  replaceCmsSiteMirror,
  resolvePlatformCmsConfig,
} from "./platform-control-service";

export type SyncTrigger = "manual" | "scheduled";

export interface SyncContext {
  actor?: null | string;
  /** The platform admin who pressed the button, for the run row. */
  startedBy?: null | string;
  trigger: SyncTrigger;
}

/** Classify a thrown CMS error into something a Persian message can be chosen from. */
export function cmsErrorCode(error: unknown): string {
  if (error instanceof CmsNetworkError) return "cms_unreachable";
  if (error instanceof CmsApiError) {
    if (error.status === 401 || error.status === 403) return "cms_forbidden";
    if (error.status === 404) return "cms_not_found";
    if (error.status === 409) return "site_mismatch";
    return `cms_error_${error.status}`;
  }
  return "cms_failed";
}

export interface MirrorResult {
  complete: boolean;
  error?: string;
  ok: boolean;
  sites: number;
}

/** Refresh `platform_cms_sites` from the CMS. */
export async function runCmsMirror(context: SyncContext): Promise<MirrorResult> {
  const started = Date.now();
  const config = await resolvePlatformCmsConfig();
  if (!config) {
    return { complete: false, error: "cms_not_configured", ok: false, sites: 0 };
  }

  try {
    const { complete, sites } = await fetchAllCmsSites(config, { actor: context.actor });
    await replaceCmsSiteMirror(sites);
    await recordCmsSyncRun({
      detail: { complete },
      durationMs: Date.now() - started,
      items: sites.length,
      kind: "mirror",
      startedBy: context.startedBy ?? null,
      // "Partial" is not a failure and not a success: the page cap was hit, so the
      // mirror is real data that does not cover the whole fleet, and the delete
      // pass has therefore removed nothing it should not have — but an operator
      // reading the table needs to know the list is short.
      status: complete ? "ok" : "partial",
      trigger: context.trigger,
      updated: sites.length,
    });
    return { complete, ok: true, sites: sites.length };
  } catch (error) {
    const code = cmsErrorCode(error);
    await recordMirrorFailure(code);
    await recordCmsSyncRun({
      durationMs: Date.now() - started,
      error: code,
      kind: "mirror",
      startedBy: context.startedBy ?? null,
      status: "failed",
      trigger: context.trigger,
    });
    return { complete: false, error: code, ok: false, sites: 0 };
  }
}

export interface EventsResult {
  error?: string;
  ok: boolean;
  shipped: number;
  skippedReason?: "no_collector";
}

/**
 * Poll the CMS event feed and ship it.
 *
 * With no collector configured this is a no-op that says so, rather than polling
 * the CMS to throw the answer away — a network call whose result nothing reads is
 * the definition of a cost with no benefit.
 */
export async function runCmsEventShipping(context: SyncContext): Promise<EventsResult> {
  const started = Date.now();
  if (!cmsObservabilityEnabled()) {
    return { ok: true, shipped: 0, skippedReason: "no_collector" };
  }
  const config = await resolvePlatformCmsConfig();
  if (!config) return { error: "cms_not_configured", ok: false, shipped: 0 };

  const stored = await getCmsControlConfig();

  try {
    const page = await fetchCmsEvents(
      config,
      { limit: 200, since: stored.eventsCursor },
      { actor: context.actor },
    );
    const shipped = logCmsFeedEvents(page.events);
    await advanceCmsEventsCursor(page.cursor, shipped);
    await recordCmsSyncRun({
      detail: { cursor: page.cursor, since: page.since },
      durationMs: Date.now() - started,
      items: shipped,
      kind: "events",
      startedBy: context.startedBy ?? null,
      status: "ok",
      trigger: context.trigger,
    });
    return { ok: true, shipped };
  } catch (error) {
    const code = cmsErrorCode(error);
    await recordEventsFailure(code);
    await recordCmsSyncRun({
      durationMs: Date.now() - started,
      error: code,
      kind: "events",
      startedBy: context.startedBy ?? null,
      status: "failed",
      trigger: context.trigger,
    });
    return { error: code, ok: false, shipped: 0 };
  }
}

export interface PullResult {
  error?: string;
  ok: boolean;
  snapshot?: CmsSnapshot;
}

/**
 * Export one site's content.
 *
 * The snapshot is returned to the caller rather than stored: it is the operator's
 * artefact (they download it, or hand it straight back to a push), and keeping a
 * copy of every customer's content in this deployment's database would be a second
 * store of somebody else's data with no retention policy behind it.
 */
export async function runCmsPull(
  siteId: string,
  input: { collections?: string[] },
  context: SyncContext,
): Promise<PullResult> {
  const started = Date.now();
  const config = await resolvePlatformCmsConfig();
  if (!config) return { error: "cms_not_configured", ok: false };

  try {
    const snapshot = await exportCmsSnapshot(
      config,
      siteId,
      { collections: input.collections },
      { actor: context.actor },
    );
    const items = Object.values(snapshot.counts).reduce((sum, n) => sum + n, 0);
    await recordCmsSyncRun({
      detail: { counts: snapshot.counts, truncated: snapshot.truncated },
      durationMs: Date.now() - started,
      items,
      kind: "pull",
      siteId,
      startedBy: context.startedBy ?? null,
      status: snapshot.truncated.length ? "partial" : "ok",
      trigger: context.trigger,
    });
    return { ok: true, snapshot };
  } catch (error) {
    const code = cmsErrorCode(error);
    await recordCmsSyncRun({
      durationMs: Date.now() - started,
      error: code,
      kind: "pull",
      siteId,
      startedBy: context.startedBy ?? null,
      status: "failed",
      trigger: context.trigger,
    });
    return { error: code, ok: false };
  }
}

export interface PushResult {
  error?: string;
  ok: boolean;
  result?: CmsImportResult;
}

export async function runCmsPush(
  siteId: string,
  input: { collections?: string[]; dryRun?: boolean; force?: boolean; snapshot: unknown },
  context: SyncContext,
): Promise<PushResult> {
  const started = Date.now();
  const config = await resolvePlatformCmsConfig();
  if (!config) return { error: "cms_not_configured", ok: false };

  try {
    const result = await importCmsSnapshot(config, siteId, input, { actor: context.actor });
    await recordCmsSyncRun({
      created: result.summary.created,
      detail: { errors: result.errors.slice(0, 20) },
      dryRun: result.dryRun,
      durationMs: Date.now() - started,
      // The counts are the CMS's own plan, not what we sent: a write is only
      // applied to the extent the other side says it was.
      items: result.plan.length,
      kind: "push",
      siteId,
      skipped: result.summary.skipped,
      startedBy: context.startedBy ?? null,
      status: result.errors.length ? "partial" : "ok",
      trigger: context.trigger,
      updated: result.summary.updated,
    });
    return { ok: true, result };
  } catch (error) {
    const code = cmsErrorCode(error);
    await recordCmsSyncRun({
      dryRun: input.dryRun === true,
      durationMs: Date.now() - started,
      error: code,
      kind: "push",
      siteId,
      startedBy: context.startedBy ?? null,
      status: "failed",
      trigger: context.trigger,
    });
    return { error: code, ok: false };
  }
}

export interface TickResult {
  events?: EventsResult;
  mirror?: MirrorResult;
  ran: boolean;
}

/**
 * What `server.ts` calls on its timer.
 *
 * The mirror runs on the operator's configured interval; event shipping runs every
 * tick it is switched on, because a log tail's usefulness is its freshness and one
 * cursor-scoped call is cheap. Both are opt-in (`mirror_enabled`,
 * `log_shipping_enabled`, both default false in migration 0139), so a deployment
 * with no CMS makes no network calls at all — a migration must not turn a POS into
 * an HTTP client for a service it has never heard of.
 */
export async function runCmsControlTick(now = Date.now()): Promise<TickResult> {
  const config: CmsControlConfig = await getCmsControlConfig();
  if (!config.baseUrl) return { ran: false };

  const out: TickResult = { ran: false };

  if (mirrorIsDue(config, now)) {
    out.mirror = await runCmsMirror({ actor: "scheduled", trigger: "scheduled" });
    out.ran = true;
  }

  if (config.logShippingEnabled) {
    out.events = await runCmsEventShipping({ actor: "scheduled", trigger: "scheduled" });
    out.ran = true;
  }

  return out;
}
