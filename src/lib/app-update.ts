/**
 * App self-update over the existing server-sync channel.
 *
 * The café laptop already has an authenticated, Owner-established
 * relationship with the VPS: the per-business sync token configured at
 * «اتصال‌های فنی» → «سرور راه دور» (server-sync.ts). This reuses that
 * exact pairing so a laptop can learn about and fetch a newer app image
 * without ever holding a long-lived registry credential — the VPS mints a
 * short-lived GHCR pull token per request (github-app-token.ts), and only an
 * already-paired business (i.e. one an Owner configured) can ask for one.
 *
 * Two remote calls, deliberately kept separate:
 *   - update-check: reports this server's own running version. No GitHub API
 *     call, so it's cheap enough for the 30s sync tick to poll for dashboard
 *     visibility (refreshAppUpdateStatus, persisted — no credential in it).
 *   - update-token: mints a fresh ~1h pull credential. Only called right
 *     before an actual `docker pull`, by scripts/check-app-update.ts — never
 *     persisted anywhere, on either side.
 *
 * See docs/server-sync.md "Self-update" for the one-time GitHub App setup
 * this requires on the VPS, and windows/Start-CafePOS.bat for how the
 * laptop's launcher consumes it.
 */
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import type { ServerSyncConfig } from "./server-sync-config";
import { isGithubAppConfigured, mintPackageReadToken } from "./github-app-token";
import { computeUpdateAvailable, imageRefFor } from "./app-update-status";

const GHCR_IMAGE = process.env.GHCR_IMAGE?.trim() || "ghcr.io/hamidnoshady/cafe-restaurant-pos";

/** The sha this running process was built from — baked in at image build time (see Dockerfile). */
export function currentAppVersion(): string {
  return process.env.APP_IMAGE_SHA?.trim() || "unknown";
}

// ---------------------------------------------------------------------------
// Remote side (runs on the VPS, called by a paired local laptop)
// ---------------------------------------------------------------------------

export interface UpdateCheckResponse {
  version: string;
  imageRef: string;
}

/** No GitHub API call — just reports what this server is already running. */
export function buildUpdateCheckResponse(): UpdateCheckResponse {
  const version = currentAppVersion();
  return { version, imageRef: imageRefFor(GHCR_IMAGE, version) };
}

export type UpdateTokenResponse =
  | { ok: true; imageRef: string; registryToken: string; expiresAt: string }
  | { ok: false; error: "not_configured" | "mint_failed" };

/** Mints a fresh, short-lived pull credential. Never cached — see module doc. */
export async function buildUpdateTokenResponse(): Promise<UpdateTokenResponse> {
  if (!isGithubAppConfigured()) return { ok: false, error: "not_configured" };
  const token = await mintPackageReadToken();
  if (!token) return { ok: false, error: "mint_failed" };
  return {
    ok: true,
    imageRef: imageRefFor(GHCR_IMAGE, currentAppVersion()),
    registryToken: token.token,
    expiresAt: token.expiresAt,
  };
}

// ---------------------------------------------------------------------------
// Local side (runs on the café laptop, calls the paired VPS)
// ---------------------------------------------------------------------------

export interface AppUpdateStatus {
  checkedAt: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  error: string | null;
}

export async function getAppUpdateStatus(businessId: string): Promise<AppUpdateStatus | null> {
  return getSetting<AppUpdateStatus>(businessId, SETTING_KEYS.appUpdateStatus);
}

function remoteUrlFor(config: ServerSyncConfig, path: string): string {
  return `${config.remoteUrl.trim().replace(/\/+$/, "")}${path}`;
}

/**
 * Called from the sync tick. Persists the result so the Owner dashboard can
 * show "update available" — deliberately carries no credential, so it's safe
 * to store and to return from an authenticated GET.
 */
export async function refreshAppUpdateStatus(
  businessId: string,
  config: ServerSyncConfig | null,
): Promise<AppUpdateStatus> {
  const currentVersion = currentAppVersion();

  const save = async (status: AppUpdateStatus): Promise<AppUpdateStatus> => {
    await setSetting(businessId, SETTING_KEYS.appUpdateStatus, status);
    return status;
  };

  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim()) {
    return save({
      checkedAt: new Date().toISOString(),
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      error: "sync_not_configured",
    });
  }

  try {
    const res = await fetch(remoteUrlFor(config, "/api/server-sync/update-check"), {
      headers: { Authorization: `Bearer ${config.token.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return save({
        checkedAt: new Date().toISOString(),
        currentVersion,
        latestVersion: null,
        updateAvailable: false,
        error: `remote_rejected: HTTP ${res.status}`,
      });
    }
    const body = (await res.json()) as UpdateCheckResponse;
    return save({
      checkedAt: new Date().toISOString(),
      currentVersion,
      latestVersion: body.version,
      updateAvailable: computeUpdateAvailable(currentVersion, body.version),
      error: null,
    });
  } catch (err) {
    return save({
      checkedAt: new Date().toISOString(),
      currentVersion,
      latestVersion: null,
      updateAvailable: false,
      error: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

export interface UpdatePullCredential {
  imageRef: string;
  registryToken: string;
  expiresAt: string;
}

/**
 * Called only right before an actual `docker pull` (scripts/check-app-update.ts).
 * Fetches a fresh credential every time; the result must never be persisted.
 */
export async function fetchUpdatePullCredential(
  config: ServerSyncConfig,
): Promise<{ ok: true; credential: UpdatePullCredential } | { ok: false; error: string }> {
  if (!config.enabled || !config.remoteUrl?.trim() || !config.token?.trim()) {
    return { ok: false, error: "sync_not_configured" };
  }
  try {
    const res = await fetch(remoteUrlFor(config, "/api/server-sync/update-token"), {
      headers: { Authorization: `Bearer ${config.token.trim()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, error: `remote_rejected: HTTP ${res.status}` };
    const body = (await res.json()) as UpdatePullCredential;
    return { ok: true, credential: body };
  } catch (err) {
    return { ok: false, error: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}
