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
import { query } from "./db";
import { getSetting, setSetting, SETTING_KEYS } from "./settings";
import { applySyncEvent, type SyncEventInput, type SyncEventType } from "./sync-events";

// ---------------------------------------------------------------------------
// Config & state types
// ---------------------------------------------------------------------------

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
};

export async function getServerSyncConfig(businessId: string): Promise<ServerSyncConfig | null> {
  return getSetting<ServerSyncConfig>(businessId, SETTING_KEYS.serverSyncConfig);
}

export async function setServerSyncConfig(businessId: string, config: ServerSyncConfig): Promise<void> {
  await setSetting(businessId, SETTING_KEYS.serverSyncConfig, config);
}

export async function getServerSyncState(businessId: string): Promise<ServerSyncState> {
  const s = await getSetting<ServerSyncState>(businessId, SETTING_KEYS.serverSyncState);
  return s ?? { ...EMPTY_STATE };
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
    } catch {
      // Log but don't abort the batch — a single bad event shouldn't block the rest
      console.error(`server-sync pull: failed to apply event ${e.clientEventId}`);
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
  const { rows } = await query<{ business_id: string }>(
    `SELECT business_id FROM settings WHERE key = $1 AND location_id IS NULL`,
    [SETTING_KEYS.serverSyncConfig],
  );
  for (const row of rows) {
    try {
      await runServerPush(row.business_id);
    } catch (err) {
      console.error(`server-sync push failed for business ${row.business_id}:`, err);
    }
    try {
      await runServerPull(row.business_id);
    } catch (err) {
      console.error(`server-sync pull failed for business ${row.business_id}:`, err);
    }
  }
}

export const SERVER_SYNC_INTERVAL_MS = 30_000; // 30 s
