/**
 * Bidirectional server-to-server sync (Phase 11).
 *
 * Architecture:
 *   LOCAL server (café laptop) ←→ REMOTE server (VPS / pos.eshobe.com)
 *
 * Push: local sends its unsynced sync_events rows to the remote's
 *   POST /api/server-sync/push endpoint, which replays them via the
 *   existing applySyncEvent() engine — same idempotency guarantees as
 *   the client offline-queue flush.
 *
 * Pull: local calls GET /api/server-sync/pull?after=<last_pulled_id>
 *   on the remote, receives events the remote accepted from *other*
 *   sources (e.g. owner making a menu change remotely), and replays
 *   them locally.
 *
 * Conflict resolution: identical to the client queue — the
 *   UNIQUE(location_id, client_event_id) constraint on sync_events
 *   deduplicates replays; classifyStatusReplay() handles status
 *   machine conflicts. No extra logic needed.
 *
 * Config is stored in the settings table under SETTING_KEYS.serverSyncConfig.
 * State (high-water marks) is stored under SETTING_KEYS.serverSyncState.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { query, withTenant, withoutTenantScope } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { applySyncEvent, type SyncEventInput, type SyncEventType } from "./sync-events";
import type { ServerSyncConfig } from "./server-sync-config";
import { refreshAppUpdateStatus } from "./app-update";

export type { ServerSyncConfig } from "./server-sync-config";

// ---------------------------------------------------------------------------
// Config & state types
// ---------------------------------------------------------------------------

export interface ServerSyncState {
  /** sync_events.id of the last row we successfully pushed to remote */
  lastPushedEventId: number | null;
  /** sync_events.id of the last row we successfully pulled from remote */
  lastPulledEventId: number | null;
  lastPushAttemptAt: string | null;
  lastPullAttemptAt: string | null;
  lastPushSuccessAt: string | null;
  lastPullSuccessAt: string | null;
  lastPushError: string | null;
  lastPullError: string | null;
  /**
   * Last time this business's incoming push/pull authenticated via the
   * shared REMOTE_SYNC_TOKEN fallback instead of its own per-business token —
   * see recordLegacyTokenUsage(). Null if it has never happened.
   */
  legacyTokenLastUsedAt: string | null;
}

const EMPTY_STATE: ServerSyncState = {
  lastPushedEventId: null,
  lastPulledEventId: null,
  lastPushAttemptAt: null,
  lastPullAttemptAt: null,
  lastPushSuccessAt: null,
  lastPullSuccessAt: null,
  lastPushError: null,
  lastPullError: null,
  legacyTokenLastUsedAt: null,
};

export async function getServerSyncConfig(businessId: string): Promise<ServerSyncConfig | null> {
  return getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
}

function hashSyncToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Alongside the existing settings-stored config, keeps `server_sync_tokens`
 * (migration 0033) in lockstep — an indexed hash the *receiving* side's
 * push/pull routes look up to resolve which business an incoming request is
 * for, rather than trusting one shared REMOTE_SYNC_TOKEN for the whole
 * server. Called from within a normal tenant-scoped request (the owner's
 * own config PUT), so this insert needs no bypass — RLS's own WITH CHECK
 * already confines it to the caller's business.
 */
export async function setServerSyncConfig(businessId: string, config: ServerSyncConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.serverSyncConfig, config);
  if (config.token) {
    await query(
      `INSERT INTO server_sync_tokens (business_id, token_hash, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (business_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, updated_at = now()`,
      [businessId, hashSyncToken(config.token)],
    );
  } else {
    await query(`DELETE FROM server_sync_tokens WHERE business_id = $1`, [businessId]);
  }
}

/**
 * Resolves an incoming server-sync bearer token to the business it belongs
 * to, or null if it matches no configured token. Runs before any tenant is
 * chosen — the token *is* how a business gets identified here — the same
 * bypass category as resolving a login email across businesses.
 */
export async function resolveBusinessBySyncToken(token: string): Promise<string | null> {
  const { rows } = await withoutTenantScope("server-sync-auth", () =>
    query<{ business_id: string }>(`SELECT business_id FROM server_sync_tokens WHERE token_hash = $1`, [
      hashSyncToken(token),
    ]),
  );
  return rows[0]?.business_id ?? null;
}

/**
 * Constant-time comparison for the legacy single-secret REMOTE_SYNC_TOKEN
 * path (kept for deployments that haven't configured a per-business token
 * yet — see the two receiving routes). Hashing both sides first means the
 * comparison is always between two fixed-length digests, so a length
 * mismatch can't itself leak anything and `timingSafeEqual` never throws.
 */
export function tokensMatch(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashSyncToken(a)), Buffer.from(hashSyncToken(b)));
}

export async function getServerSyncState(businessId: string): Promise<ServerSyncState> {
  const s = await getSetting<ServerSyncState>(businessId, SETTING_KEYS.serverSyncState);
  return s ? { ...EMPTY_STATE, ...s } : { ...EMPTY_STATE };
}

/**
 * Called by the push/pull routes whenever an incoming request authenticates
 * via the shared REMOTE_SYNC_TOKEN fallback rather than this business's own
 * per-business token — the weaker of the two paths (see tokensMatch's doc
 * comment). Otherwise a deployment can stay on it indefinitely with no way
 * for the owner to notice, since the fallback works identically from the
 * caller's point of view. Runs within the caller's own withTenant() scope.
 */
export async function recordLegacyTokenUsage(businessId: string): Promise<void> {
  console.warn(`server-sync: business ${businessId} authenticated via the legacy REMOTE_SYNC_TOKEN fallback`);
  const state = await getServerSyncState(businessId);
  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...state,
    legacyTokenLastUsedAt: new Date().toISOString(),
  } satisfies ServerSyncState);
}

export interface ServerSyncDeadLetter {
  id: number;
  remoteEventId: number;
  locationId: string;
  clientEventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  error: string;
  createdAt: string;
}

/** Pulled events that failed to apply and were dropped from the pull's forward progress; see runServerPull. */
export async function listServerSyncDeadLetters(businessId: string, limit = 50): Promise<ServerSyncDeadLetter[]> {
  const { rows } = await query<{
    id: number;
    remote_event_id: number;
    location_id: string;
    client_event_id: string;
    event_type: string;
    payload: Record<string, unknown>;
    error: string;
    created_at: string;
  }>(
    `SELECT id, remote_event_id, location_id, client_event_id, event_type, payload, error, created_at
       FROM server_sync_dead_letters
      WHERE business_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [businessId, limit],
  );
  return rows.map((r) => ({
    // bigint columns come back from pg as strings; safe to convert here since
    // these are small monotonic counters, never anywhere near MAX_SAFE_INTEGER.
    id: Number(r.id),
    remoteEventId: Number(r.remote_event_id),
    locationId: r.location_id,
    clientEventId: r.client_event_id,
    eventType: r.event_type,
    payload: r.payload,
    error: r.error,
    createdAt: r.created_at,
  }));
}

export interface PairedSite {
  /** When this business's sync token was last issued or rotated. */
  tokenSetAt: string;
  /** Most recent inbound push/pull this business saw, or null if none yet. */
  lastSeenAt: string | null;
  lastSeenStatus: "ok" | "error" | "skipped" | null;
}

/**
 * What a *central* server can say about the site paired to this business.
 *
 * Singular, not a list, because that is what the schema models:
 * `server_sync_tokens` is keyed by `business_id` (migration 0033), so one
 * paired install per business is the design, and setServerSyncConfig replaces
 * the row rather than appending. Returns null when nothing is paired yet.
 */
export async function getPairedSite(businessId: string): Promise<PairedSite | null> {
  const [tokenRes, logRes] = await Promise.all([
    query<{ updated_at: string }>(`SELECT updated_at FROM server_sync_tokens WHERE business_id = $1`, [businessId]),
    query<{ attempted_at: string; status: "ok" | "error" | "skipped" }>(
      `SELECT attempted_at, status FROM server_sync_log
        WHERE business_id = $1
        ORDER BY attempted_at DESC
        LIMIT 1`,
      [businessId],
    ),
  ]);

  if (!tokenRes.rows[0]) return null;
  return {
    tokenSetAt: tokenRes.rows[0].updated_at,
    lastSeenAt: logRes.rows[0]?.attempted_at ?? null,
    lastSeenStatus: logRes.rows[0]?.status ?? null,
  };
}

// ---------------------------------------------------------------------------
// Row type returned by sync_events queries
// ---------------------------------------------------------------------------

type SyncEventRow = {
  id: number;
  location_id: string;
  client_event_id: string;
  event_type: SyncEventType;
  payload: Record<string, unknown>;
  occurred_at: string;
  actor_user_id: string;
  actor_role: string;
};

// ---------------------------------------------------------------------------
// Push: local → remote
// ---------------------------------------------------------------------------

export type PushResult =
  | { status: "disabled" }
  | { status: "ok"; pushed: number }
  | { status: "error"; error: string };

/**
 * Fetch unsynced rows from local sync_events and POST them to the remote.
 * Idempotent: the remote deduplicates on (location_id, client_event_id).
 */
export async function runServerPush(businessId: string): Promise<PushResult> {
  const config = await getServerSyncConfig(businessId);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim()) {
    return { status: "disabled" };
  }

  const state = await getServerSyncState(businessId);
  const batchSize = config.batchSize ?? 100;
  const afterId = state.lastPushedEventId ?? 0;

  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...state,
    lastPushAttemptAt: new Date().toISOString(),
  } satisfies ServerSyncState);

  const fail = async (error: string): Promise<PushResult> => {
    const s = await getServerSyncState(businessId);
    await setSetting(businessId, SETTING_KEYS.serverSyncState, {
      ...s,
      lastPushError: error,
    } satisfies ServerSyncState);
    await query(
      `INSERT INTO server_sync_log (business_id, direction, status, events_count, error, last_event_id)
       VALUES ($1, 'push', 'error', 0, $2, $3)`,
      [businessId, error, afterId],
    );
    return { status: "error", error };
  };

  // Fetch the next batch of local sync_events rows
  let rows: SyncEventRow[];
  try {
    const { rows: r } = await query<SyncEventRow>(
      `SELECT se.id, se.location_id, se.client_event_id, se.event_type,
              se.payload, se.occurred_at,
              se.actor_user_id, se.actor_role
         FROM sync_events se
         JOIN locations l ON l.id = se.location_id
        WHERE l.business_id = $1
          AND se.id > $2
          AND se.applied_at IS NOT NULL
          AND se.error IS NULL
          AND (se.origin IS NULL OR se.origin = 'local')
        ORDER BY se.id
        LIMIT $3`,
      [businessId, afterId, batchSize],
    );
    rows = r;
  } catch (err) {
    return fail(`query_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (rows.length === 0) {
    await query(
      `INSERT INTO server_sync_log (business_id, direction, status, events_count, last_event_id)
       VALUES ($1, 'push', 'skipped', 0, $2)`,
      [businessId, afterId],
    );
    return { status: "ok", pushed: 0 };
  }

  const events = rows.map((r) => ({
    clientEventId: r.client_event_id,
    type: r.event_type,
    occurredAt: typeof r.occurred_at === "string" ? r.occurred_at : new Date(r.occurred_at).toISOString(),
    payload: r.payload,
    locationId: r.location_id,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
  }));

  const url = `${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/push`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token.trim()}`,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      return fail(`remote_rejected: HTTP ${res.status}`);
    }
  } catch (err) {
    return fail(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  const lastId = rows[rows.length - 1].id;
  const s = await getServerSyncState(businessId);
  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...s,
    lastPushedEventId: lastId,
    lastPushSuccessAt: new Date().toISOString(),
    lastPushError: null,
  } satisfies ServerSyncState);
  await query(
    `INSERT INTO server_sync_log (business_id, direction, status, events_count, last_event_id)
     VALUES ($1, 'push', 'ok', $2, $3)`,
    [businessId, rows.length, lastId],
  );
  return { status: "ok", pushed: rows.length };
}

// ---------------------------------------------------------------------------
// Pull: remote → local
// ---------------------------------------------------------------------------

export type PullResult =
  | { status: "disabled" }
  | { status: "ok"; pulled: number }
  | { status: "error"; error: string };

interface RemoteEvent {
  id: number;
  clientEventId: string;
  type: SyncEventType;
  occurredAt: string;
  payload: Record<string, unknown>;
  locationId: string;
  actorUserId: string;
  actorRole: string;
}

/**
 * Fetch events from the remote that we haven't seen yet and replay them
 * locally via applySyncEvent() — same engine as the client offline queue.
 */
export async function runServerPull(businessId: string): Promise<PullResult> {
  const config = await getServerSyncConfig(businessId);
  if (!config?.enabled || !config.remoteUrl?.trim() || !config.token?.trim()) {
    return { status: "disabled" };
  }

  const state = await getServerSyncState(businessId);
  const batchSize = config.batchSize ?? 100;
  const afterId = state.lastPulledEventId ?? 0;

  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...state,
    lastPullAttemptAt: new Date().toISOString(),
  } satisfies ServerSyncState);

  const fail = async (error: string): Promise<PullResult> => {
    const s = await getServerSyncState(businessId);
    await setSetting(businessId, SETTING_KEYS.serverSyncState, {
      ...s,
      lastPullError: error,
    } satisfies ServerSyncState);
    await query(
      `INSERT INTO server_sync_log (business_id, direction, status, events_count, error, last_event_id)
       VALUES ($1, 'pull', 'error', 0, $2, $3)`,
      [businessId, error, afterId],
    );
    return { status: "error", error };
  };

  // Fetch from remote
  const url = `${config.remoteUrl.trim().replace(/\/+$/, "")}/api/server-sync/pull?after=${afterId}&limit=${batchSize}`;
  let remoteEvents: RemoteEvent[];
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token.trim()}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return fail(`remote_rejected: HTTP ${res.status}`);
    const body = (await res.json()) as { events: RemoteEvent[] };
    remoteEvents = body.events ?? [];
  } catch (err) {
    return fail(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (remoteEvents.length === 0) {
    await query(
      `INSERT INTO server_sync_log (business_id, direction, status, events_count, last_event_id)
       VALUES ($1, 'pull', 'skipped', 0, $2)`,
      [businessId, afterId],
    );
    return { status: "ok", pulled: 0 };
  }

  // Replay each event locally in order
  let lastAppliedRemoteId = afterId;
  for (const e of remoteEvents) {
    const input: SyncEventInput = {
      clientEventId: e.clientEventId,
      type: e.type,
      occurredAt: e.occurredAt,
      payload: e.payload,
    };
    try {
      await applySyncEvent(
        e.locationId,
        { userId: e.actorUserId, role: e.actorRole as import("./auth").Role },
        input,
        "remote",
      );
    } catch (err) {
      // Don't abort the batch — a single bad event shouldn't block the rest —
      // but the high-water mark below still advances past it, so record it
      // as a dead letter rather than only logging: otherwise it's dropped
      // forever with nothing to show it happened.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`server-sync pull: failed to apply event ${e.clientEventId}: ${message}`);
      await query(
        `INSERT INTO server_sync_dead_letters
           (business_id, remote_event_id, location_id, client_event_id, event_type, payload, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [businessId, e.id, e.locationId, e.clientEventId, e.type, JSON.stringify(e.payload), message],
      ).catch((logErr) => {
        console.error(`server-sync pull: failed to record dead letter for event ${e.clientEventId}:`, logErr);
      });
    }
    lastAppliedRemoteId = e.id;
  }

  const s = await getServerSyncState(businessId);
  await setSetting(businessId, SETTING_KEYS.serverSyncState, {
    ...s,
    lastPulledEventId: lastAppliedRemoteId,
    lastPullSuccessAt: new Date().toISOString(),
    lastPullError: null,
  } satisfies ServerSyncState);
  await query(
    `INSERT INTO server_sync_log (business_id, direction, status, events_count, last_event_id)
     VALUES ($1, 'pull', 'ok', $2, $3)`,
    [businessId, remoteEvents.length, lastAppliedRemoteId],
  );
  return { status: "ok", pulled: remoteEvents.length };
}

// ---------------------------------------------------------------------------
// Combined tick (push then pull)
// ---------------------------------------------------------------------------

export async function runServerSyncTick(): Promise<void> {
  // Discovery spans tenants; each business's sync then runs scoped to it.
  const rows = await withoutTenantScope("platform", async () => {
    const result = await query<{ business_id: string }>(
      `SELECT business_id FROM settings WHERE key = $1 AND location_id IS NULL`,
      [SETTING_KEYS.serverSyncConfig],
    );
    return result.rows;
  });

  for (const row of rows) {
    try {
      await withTenant(row.business_id, () => runServerPush(row.business_id));
    } catch (err) {
      console.error(`server-sync push failed for business ${row.business_id}:`, err);
    }
    try {
      await withTenant(row.business_id, () => runServerPull(row.business_id));
    } catch (err) {
      console.error(`server-sync pull failed for business ${row.business_id}:`, err);
    }
    try {
      // Dashboard visibility only — no credential involved. See app-update.ts.
      await withTenant(row.business_id, async () => {
        const config = await getServerSyncConfig(row.business_id);
        await refreshAppUpdateStatus(row.business_id, config);
      });
    } catch (err) {
      console.error(`app-update check failed for business ${row.business_id}:`, err);
    }
  }
}

export const SERVER_SYNC_INTERVAL_MS = 30_000; // 30 s
