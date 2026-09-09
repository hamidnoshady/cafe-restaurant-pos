/**
 * The operator's side of the CMS control plane — the pure half.
 *
 * Migration 0122 connected one business to its own site. This module is the
 * *platform* relationship: the address of the eshobe-cms deployment, the
 * `role: "platform"` credential that administers all of it, and the shapes the
 * super-admin console's «سایت‌ساز» section renders. Everything here is
 * framework-free and unit-tested in `platform-control.test.ts`; the DB-touching
 * store is `platform-control-service.ts` and the HTTP client is
 * `platform-client.ts`.
 *
 * Two rules this file exists to hold:
 *
 *  - **An empty credential submission means "unchanged", never "delete".** The
 *    console renders the key masked (it is never returned), so every save posts it
 *    empty — treating that as deletion would wipe the platform's root credential
 *    for its own website platform the moment somebody fixed a typo in the label.
 *    `clearApiKey: true` is the explicit door, exactly as the CMS's own gateway
 *    and storage credentials work.
 *  - **The address is normalized before it is stored, not when it is used.** A
 *    base URL with credentials in it, a query string, or a fragment is a paste of
 *    the wrong field; `http://` is legitimate for a CMS on the same private
 *    network and a mistake over the public internet, so it needs the operator to
 *    say which — the same distinction `normalizePeerBaseUrl` draws for a backup
 *    peer's address.
 */

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

export type CmsUrlResult =
  | { ok: true; secure: boolean; url: string }
  | { error: "credentials_in_url" | "https_required" | "invalid_url" | "too_long"; ok: false };

/**
 * Normalize the CMS control-plane origin an operator pastes.
 *
 * Accepted: `https://cms.eshobe.com`, `http://web:3000` (with `allowInsecure`), a
 * base carrying a path prefix. Rejected: embedded credentials, a query, a
 * fragment, any scheme but http/https, and plain http unless it was allowed.
 * The result has no trailing slash, so `${baseUrl}/api/...` never doubles a
 * separator.
 */
export function normalizeCmsControlUrl(
  raw: unknown,
  opts: { allowInsecure?: boolean } = {},
): CmsUrlResult {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return { error: "invalid_url", ok: false };
  if (value.length > 512) return { error: "too_long", ok: false };
  if (/[\s\0\u200b-\u200f]/.test(value)) return { error: "invalid_url", ok: false };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: "invalid_url", ok: false };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "invalid_url", ok: false };
  if (!url.hostname) return { error: "invalid_url", ok: false };
  // A "CMS address" that carries a password is either a paste error or a trick.
  if (url.username || url.password) return { error: "credentials_in_url", ok: false };
  if (url.hash || url.search) return { error: "invalid_url", ok: false };

  const secure = url.protocol === "https:";
  if (!secure && !opts.allowInsecure) return { error: "https_required", ok: false };

  const path = url.pathname.replace(/\/+$/, "");
  if (/\/\/|\.\.\/|%2e/i.test(path)) return { error: "invalid_url", ok: false };

  return { ok: true, secure, url: `${url.protocol}//${url.host}${path}` };
}

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

/** The CMS mints `eshobe_live_…` (see its `src/lib/api-keys.ts`). */
const KEY_SHAPE = /^[A-Za-z0-9_.-]{16,200}$/;

export type CmsKeyResult = { key: string; ok: true } | { ok: false; reason: "invalid_shape" };

export function normalizeCmsPlatformKey(raw: unknown): CmsKeyResult {
  const key = typeof raw === "string" ? raw.trim() : "";
  if (!KEY_SHAPE.test(key)) return { ok: false, reason: "invalid_shape" };
  return { key, ok: true };
}

/**
 * The last four characters, so the console can say *which* key is stored.
 *
 * Four is not enough to authenticate with and is enough to tell one rotation from
 * the next — the same trade-off `peerTokenHint` makes for a backup peer's token.
 */
export function cmsKeyHint(key: string): string {
  const trimmed = key.trim();
  return trimmed.length <= 4 ? "" : `…${trimmed.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// The stored configuration, as the console sees it
// ---------------------------------------------------------------------------

export interface CmsControlConfig {
  allowInsecure: boolean;
  baseUrl: string;
  eventsCursor: null | string;
  eventsShipped: number;
  label: string;
  lastEventsAt: null | string;
  lastEventsError: null | string;
  lastMirrorAt: null | string;
  lastMirrorError: null | string;
  logShippingEnabled: boolean;
  mirrorEnabled: boolean;
  mirrorIntervalMinutes: number;
  updatedAt: null | string;
  verifiedAt: null | string;
  verifyError: null | string;
}

/**
 * What the console is allowed to see: the config plus a *hint* of the key, and
 * two derived booleans it would otherwise have to infer.
 *
 * `apiKeyHint` is the only trace of the credential that ever leaves the server.
 */
export interface MaskedCmsControlConfig extends CmsControlConfig {
  apiKeyHint: string;
  /** A key is stored (it may still be wrong — see `verifiedAt`). */
  configured: boolean;
  /** Address *and* key are present, so a call can at least be attempted. */
  usable: boolean;
}

export function maskCmsControlConfig(
  config: CmsControlConfig,
  stored: { apiKeyHint: string; hasApiKey: boolean },
): MaskedCmsControlConfig {
  return {
    ...config,
    apiKeyHint: stored.apiKeyHint,
    configured: stored.hasApiKey,
    usable: Boolean(config.baseUrl) && stored.hasApiKey,
  };
}

export type CmsConfigPatch = {
  allowInsecure?: unknown;
  apiKey?: unknown;
  baseUrl?: unknown;
  clearApiKey?: unknown;
  label?: unknown;
  logShippingEnabled?: unknown;
  mirrorEnabled?: unknown;
  mirrorIntervalMinutes?: unknown;
};

export type CmsConfigPatchResult =
  | { changes: ValidatedCmsPatch; ok: true }
  | { errors: string[]; ok: false };

export interface ValidatedCmsPatch {
  allowInsecure?: boolean;
  /** Present only when a new key was submitted. Absent means "leave it alone". */
  apiKey?: string;
  baseUrl?: string;
  clearApiKey?: true;
  label?: string;
  logShippingEnabled?: boolean;
  mirrorEnabled?: boolean;
  mirrorIntervalMinutes?: number;
}

export const MIRROR_INTERVAL_MIN = 5;
export const MIRROR_INTERVAL_MAX = 1440;

/**
 * Validate one console save. Field order matters in exactly one place:
 * `allowInsecure` is read before `baseUrl`, because it decides whether an
 * `http://` address in the *same* submission is acceptable.
 */
export function parseCmsConfigPatch(
  body: CmsConfigPatch,
  current: { allowInsecure: boolean },
): CmsConfigPatchResult {
  const errors: string[] = [];
  const changes: ValidatedCmsPatch = {};

  const allowInsecure =
    body.allowInsecure === undefined ? current.allowInsecure : body.allowInsecure === true;
  if (body.allowInsecure !== undefined) changes.allowInsecure = allowInsecure;

  if (body.baseUrl !== undefined) {
    const result = normalizeCmsControlUrl(body.baseUrl, { allowInsecure });
    if (!result.ok) errors.push(result.error);
    else changes.baseUrl = result.url;
  }

  if (body.label !== undefined) {
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (label.length > 120) errors.push("label_too_long");
    else changes.label = label;
  }

  if (body.clearApiKey === true) {
    changes.clearApiKey = true;
  } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
    // Only a *non-empty* submission touches the credential. An empty one is the
    // masked form being saved back, not a request to delete the key.
    const key = normalizeCmsPlatformKey(body.apiKey);
    if (!key.ok) errors.push("invalid_api_key");
    else changes.apiKey = key.key;
  }

  if (body.mirrorEnabled !== undefined) changes.mirrorEnabled = body.mirrorEnabled === true;
  if (body.logShippingEnabled !== undefined) {
    changes.logShippingEnabled = body.logShippingEnabled === true;
  }

  if (body.mirrorIntervalMinutes !== undefined) {
    const minutes = Number(body.mirrorIntervalMinutes);
    if (
      !Number.isInteger(minutes) ||
      minutes < MIRROR_INTERVAL_MIN ||
      minutes > MIRROR_INTERVAL_MAX
    ) {
      errors.push("invalid_interval");
    } else changes.mirrorIntervalMinutes = minutes;
  }

  if (errors.length) return { errors, ok: false };
  if (Object.keys(changes).length === 0) return { errors: ["nothing_to_change"], ok: false };
  return { changes, ok: true };
}

// ---------------------------------------------------------------------------
// The mirror
// ---------------------------------------------------------------------------

/** One CMS site as the control API reports it (the POS-side view of `SiteReport`). */
export interface CmsSiteRow {
  aliases: { hostname: string; verified: boolean }[];
  availableLocales: string[];
  currency: null | string;
  defaultLocale: null | string;
  domain: string;
  domainVerified: boolean;
  gateways: { enabled: boolean; gateway: string; selfTest: null | string }[];
  id: string;
  name: string;
  status: string;
  totals: Record<string, number>;
  type: string;
  updatedAt: null | string;
}

/** A mirrored row read back out of `platform_cms_sites`, plus who owns it here. */
export interface MirroredCmsSite extends CmsSiteRow {
  businessId: null | string;
  businessName?: null | string;
  mirroredAt: string;
}

/**
 * Is a mirrored figure old enough that the console should say so?
 *
 * Two intervals rather than one: a mirror that ran an hour ago on a 30-minute
 * schedule has *missed* a run, and that is a different statement from "this is
 * not live data".
 */
export function mirrorIsStale(
  mirroredAt: null | string,
  intervalMinutes: number,
  now = Date.now(),
): boolean {
  if (!mirroredAt) return true;
  const at = new Date(mirroredAt).getTime();
  if (!Number.isFinite(at)) return true;
  return now - at > intervalMinutes * 2 * 60_000;
}

/**
 * Findings the console shows as a row of warnings above the table.
 *
 * Deliberately computed here rather than in the page: it is the one place both
 * the report screen and (later) an alert could agree on what "wrong" means, and
 * it is assertable without a browser.
 */
export interface CmsFleetFinding {
  count: number;
  detail: string;
  kind: "gateway_failing" | "no_business" | "suspended" | "unverified_domain";
  severity: "info" | "warn";
}

export function cmsFleetFindings(sites: readonly MirroredCmsSite[]): CmsFleetFinding[] {
  const findings: CmsFleetFinding[] = [];

  const unverified = sites.filter((site) => !site.domainVerified);
  if (unverified.length) {
    findings.push({
      count: unverified.length,
      detail: unverified
        .slice(0, 5)
        .map((site) => site.domain)
        .join("، "),
      kind: "unverified_domain",
      severity: "warn",
    });
  }

  const suspended = sites.filter((site) => site.status !== "active");
  if (suspended.length) {
    findings.push({
      count: suspended.length,
      detail: suspended
        .slice(0, 5)
        .map((site) => site.domain)
        .join("، "),
      kind: "suspended",
      severity: "warn",
    });
  }

  const failing = sites.filter((site) => site.gateways.some((row) => row.selfTest === "failed"));
  if (failing.length) {
    findings.push({
      count: failing.length,
      detail: failing
        .slice(0, 5)
        .map((site) => site.domain)
        .join("، "),
      kind: "gateway_failing",
      severity: "warn",
    });
  }

  // A site on the CMS that no business here is billed for is not an error — an
  // operator may have provisioned it by hand — but it is the shape of a site that
  // was provisioned and then never connected, so it is worth naming.
  const orphans = sites.filter((site) => !site.businessId);
  if (orphans.length) {
    findings.push({
      count: orphans.length,
      detail: orphans
        .slice(0, 5)
        .map((site) => site.domain)
        .join("، "),
      kind: "no_business",
      severity: "info",
    });
  }

  return findings;
}

/** Persian for a finding, for the console and for a notification later. */
export const CMS_FINDING_LABELS: Record<CmsFleetFinding["kind"], string> = {
  gateway_failing: "درگاه پرداخت با خطای خودآزمایی",
  no_business: "سایت بدون کسب‌وکار متصل",
  suspended: "سایت غیرفعال یا معلق",
  unverified_domain: "دامنهٔ تأییدنشده",
};

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export const SYNC_KINDS = ["mirror", "events", "pull", "push"] as const;
export type SyncKind = (typeof SYNC_KINDS)[number];

export const SYNC_KIND_LABELS: Record<SyncKind, string> = {
  events: "دریافت رویدادها",
  mirror: "به‌روزرسانی آینهٔ سایت‌ها",
  pull: "دریافت محتوا از سایت‌ساز",
  push: "ارسال محتوا به سایت‌ساز",
};

export interface SyncRunRow {
  created: number;
  createdAt: string;
  detail: Record<string, unknown>;
  dryRun: boolean;
  durationMs: number;
  error: null | string;
  id: string;
  items: number;
  kind: SyncKind;
  siteId: null | string;
  skipped: number;
  status: "failed" | "ok" | "partial";
  trigger: "manual" | "scheduled";
  updated: number;
}

export function isSyncKind(value: unknown): value is SyncKind {
  return typeof value === "string" && (SYNC_KINDS as readonly string[]).includes(value);
}

/**
 * Is a scheduled mirror due?
 *
 * Read per call from the stored interval rather than captured at module load, for
 * the reason the CMS's own env-tunable limits are: a constant frozen at import
 * time cannot be changed by an operator and cannot be tested.
 */
export function mirrorIsDue(
  config: { lastMirrorAt: null | string; mirrorEnabled: boolean; mirrorIntervalMinutes: number },
  now = Date.now(),
): boolean {
  if (!config.mirrorEnabled) return false;
  if (!config.lastMirrorAt) return true;
  const last = new Date(config.lastMirrorAt).getTime();
  if (!Number.isFinite(last)) return true;
  return now - last >= config.mirrorIntervalMinutes * 60_000;
}
