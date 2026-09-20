/**
 * Manual release version visibility over the existing server-sync channel.
 *
 * A paired site already has an authenticated relationship with the cloud. The
 * update-check reports the remote deployment's running version so the owner can
 * see that a signed/manual desktop release may be needed. It never downloads
 * or executes an update and never mints registry credentials. Automatic
 * Electron updates remain intentionally disabled until signing and rollback
 * infrastructure exists.
 */
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import type { ServerSyncConfig } from "./server-sync-config";
import { computeUpdateAvailable } from "./app-update-status";

/** The sha this running process was built from — baked in at image build time (see Dockerfile). */
export function currentAppVersion(): string {
  return process.env.APP_RELEASE_VERSION?.trim() || process.env.APP_IMAGE_SHA?.trim() || "unknown";
}

// ---------------------------------------------------------------------------
// Remote side (runs on the VPS, called by a paired local laptop)
// ---------------------------------------------------------------------------

export interface UpdateCheckResponse {
  version: string;
}

/** No download metadata — just reports what this server is already running. */
export function buildUpdateCheckResponse(): UpdateCheckResponse {
  return { version: currentAppVersion() };
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
