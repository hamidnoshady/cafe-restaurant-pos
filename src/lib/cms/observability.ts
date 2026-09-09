/**
 * OpenObserve for the website platform — «پایش سایت‌ساز».
 *
 * `src/lib/observability.ts` made *this* deployment observable: a `console.*` tap,
 * slow/failed HTTP records, one boot beacon, and the console's «پایش» tab reading
 * them back. The CMS is a second deployment on another host, and none of that
 * reached it: its `console.error` lives for one container's lifetime, its jobs
 * queue stopping is silent, and a merchant's gateway failing its self-test is a
 * row in a table nobody queries.
 *
 * This module closes that gap without putting a collector credential on the CMS.
 * Two producers, one stream:
 *
 *   1. **Every control call this console makes** — `logCmsCall` records the
 *      operation, the outcome, the latency and the failure class. So "the console
 *      was slow to load the report" and "the CMS's overview call has been taking
 *      9 seconds since Tuesday" become the same question.
 *   2. **The CMS's own event feed** — `GET /api/platform/events` is polled on a
 *      cursor and each record is shipped as a log line, so site changes, orders,
 *      failed self-tests and issued keys land beside this deployment's own logs
 *      and can be alerted on with the same saved queries.
 *
 * Everything is a no-op when no collector is configured (`observabilityConfig()`
 * returns null), exactly like the rest of the shipper — a POS must not depend on a
 * log store, and neither must the console.
 *
 * The stream is separate from `pos_app_logs` (`OPENOBSERVE_CMS_STREAM`, default
 * `cms_events`) for one reason worth stating: a retention or an alert that is right
 * for a POS's own request log is not necessarily right for another product's audit
 * tail, and putting them in one stream would mean tuning either would tune both.
 */
import { observabilityConfig, shipEvent } from "../observability";

/** Default stream name; override with `OPENOBSERVE_CMS_STREAM`. */
export const DEFAULT_CMS_STREAM = "cms_events";

export function cmsLogStream(env: Record<string, string | undefined> = process.env): string {
  return (env.OPENOBSERVE_CMS_STREAM ?? "").trim() || DEFAULT_CMS_STREAM;
}

/** Is CMS log shipping possible at all right now? (A collector must be configured.) */
export function cmsObservabilityEnabled(): boolean {
  return observabilityConfig() !== null;
}

export type CmsCallOutcome = "api_error" | "network_error" | "ok";

export interface CmsCallRecord {
  /** The control operation, not the URL: `overview`, `sites.patch`, `snapshot.export`. */
  operation: string;
  outcome: CmsCallOutcome;
  durationMs: number;
  /** HTTP status when the CMS answered at all. */
  status?: number;
  siteId?: null | string;
  /** Who pressed the button, when a person did. `scheduled` for the tick. */
  actor?: null | string;
  message?: string;
}

/**
 * The level a call record carries.
 *
 * A network error is `error` and an API error is `warn`, deliberately: a CMS that
 * refused a call answered, which is a working link and usually an operator
 * mistake; a CMS that did not answer is the outage. Reading a level filter, the
 * two must not look the same.
 */
export function cmsCallLevel(outcome: CmsCallOutcome, status?: number): "error" | "info" | "warn" {
  if (outcome === "network_error") return "error";
  if (outcome === "api_error") return status && status >= 500 ? "error" : "warn";
  return "info";
}

/** Pure: the record as it will appear in the log store. Asserted in the unit test. */
export function buildCmsCallRecord(input: CmsCallRecord): Record<string, unknown> {
  return {
    actor: input.actor ?? "",
    cms_operation: input.operation,
    cms_outcome: input.outcome,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    level: cmsCallLevel(input.outcome, input.status),
    logger: "cms",
    message:
      input.message ??
      `CMS ${input.operation} → ${input.outcome}${input.status ? ` (${input.status})` : ""} in ${Math.round(input.durationMs)}ms`,
    site_id: input.siteId ?? "",
    ...(input.status === undefined ? {} : { status: input.status }),
  };
}

/** Ship one control-call record. Never throws, never blocks. */
export function logCmsCall(input: CmsCallRecord): void {
  shipEvent({ ...buildCmsCallRecord(input), _stream: cmsLogStream() });
}

/** One record of the CMS's own event feed, as its `/api/platform/events` returns it. */
export interface CmsFeedEvent {
  at: string;
  data?: Record<string, unknown>;
  id: string;
  kind: string;
  level: string;
  message: string;
  siteDomain: null | string;
  siteId: null | string;
}

const LEVELS = new Set(["debug", "error", "fatal", "info", "warn"]);

/**
 * Pure: one CMS feed event as a log record.
 *
 * `cms_event_id` is carried through verbatim so a duplicate shipped by an
 * overlapping poll is *identifiable* in the store rather than merely
 * indistinguishable — the cursor makes duplicates rare, this makes them findable.
 * `data` is flattened one level with a `cms_` prefix instead of nested, because a
 * log store's SQL cannot filter on a nested object without a JSON function that
 * differs per version.
 */
export function buildCmsFeedRecord(event: CmsFeedEvent): Record<string, unknown> {
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event.data ?? {})) {
    // Objects and arrays are stringified rather than dropped: a self-test detail
    // is the most useful field on the record it appears on.
    flattened[`cms_${key}`] =
      value && typeof value === "object" ? JSON.stringify(value) : (value ?? "");
  }
  return {
    ...flattened,
    cms_event_id: event.id,
    cms_kind: event.kind,
    cms_site_domain: event.siteDomain ?? "",
    level: LEVELS.has(event.level) ? event.level : "info",
    logger: "cms-event",
    message: event.message,
    site_id: event.siteId ?? "",
    // The CMS's own timestamp, kept alongside the ingest time the collector
    // stamps: a feed polled every ten minutes would otherwise show every record
    // as having happened at poll time.
    source_at: event.at,
  };
}

/** Ship a page of the CMS event feed. Returns how many records were queued. */
export function logCmsFeedEvents(events: readonly CmsFeedEvent[]): number {
  if (!cmsObservabilityEnabled()) return 0;
  const stream = cmsLogStream();
  for (const event of events) {
    shipEvent({ ...buildCmsFeedRecord(event), _stream: stream });
  }
  return events.length;
}
