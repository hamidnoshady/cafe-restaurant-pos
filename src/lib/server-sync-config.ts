/**
 * Pure resolution logic for PUT /api/server-sync/config, split out from
 * server-sync.ts (DB-touching, not unit-tested directly per repo convention)
 * the same way offline-sync.ts holds sync-events.ts's pure conflict logic.
 */
export interface ServerSyncConfig {
  /** Full URL of the remote server, e.g. https://pos.eshobe.com */
  remoteUrl: string;
  /**
   * Bearer token issued by the remote server for this local instance.
   * Generate with: openssl rand -hex 32
   * Store the same value in REMOTE_SYNC_TOKEN on the remote server.
   */
  token: string;
  enabled: boolean;
  /** How many events to push/pull per batch (default 100) */
  batchSize?: number;
}

export interface ServerSyncConfigUpdateInput {
  remoteUrl?: string;
  /** Present only when the owner typed a new token — GET only ever returns a masked one. */
  token?: string;
  enabled?: boolean;
  batchSize?: number;
}

export type ResolveConfigUpdateResult =
  | { ok: true; config: ServerSyncConfig }
  | { ok: false; error: "missing_fields" | "invalid_url" | "token_too_short" };

/**
 * Resolves a config update against the existing config. The client can't see
 * the real token once saved (only a masked preview), so it only sends a
 * `token` field when the owner typed a new one; omitting it keeps the
 * existing token, so toggling `enabled` or changing `batchSize` doesn't force
 * re-entering the secret every time.
 */
export function resolveConfigUpdate(
  existing: ServerSyncConfig | null,
  body: ServerSyncConfigUpdateInput,
): ResolveConfigUpdateResult {
  const remoteUrl = body.remoteUrl?.trim() ?? "";
  const enabled = Boolean(body.enabled);
  const batchSize = Number.isFinite(body.batchSize) ? Math.min(Math.max(Number(body.batchSize), 1), 200) : 100;

  const tokenProvided = typeof body.token === "string";
  const token = tokenProvided ? body.token!.trim() : (existing?.token ?? "");

  if (remoteUrl && !/^https?:\/\//.test(remoteUrl)) return { ok: false, error: "invalid_url" };
  if (tokenProvided && token && token.length < 16) return { ok: false, error: "token_too_short" };
  if (enabled && (!remoteUrl || !token)) return { ok: false, error: "missing_fields" };

  return { ok: true, config: { remoteUrl, token, enabled, batchSize } };
}
