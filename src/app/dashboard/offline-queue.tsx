"use client";

/**
 * Offline queue glue (Phase 5): wraps a mutation's fetch so a LAN drop mid-
 * order queues the action locally (src/lib/offline-db.ts) instead of losing
 * it, then flushes the queue to POST /api/sync/events on reconnect. See
 * docs/phases/Phase-5-Offline-Queue-Hardware.md for the conflict-handling
 * decision (offline-sync.ts) this leans on.
 */
import { useCallback, useEffect, useState } from "react";
import { getOfflineDb, type PendingAction, type PendingActionType } from "@/lib/offline-db";

type Listener = () => void;
const listeners = new Set<Listener>();
function notifyListeners(): void {
  listeners.forEach((l) => l());
}

export async function enqueueAction(action: {
  type: PendingActionType;
  payload: Record<string, unknown>;
  occurredAt: string;
  description: string;
}): Promise<void> {
  await getOfflineDb().pendingActions.add({
    ...action,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  });
  notifyListeners();
}

/**
 * POSTs or PATCHes `url` with `body`; on an actual network failure (LAN
 * drop, not a server-side rejection) queues `queue` for later replay instead
 * of throwing. Server-side rejections (validation errors, 409s, …) still
 * come back as `{ ok: false }` — only "the request never reached the
 * server" gets queued.
 */
export async function apiOrQueue<T = Record<string, unknown>>(
  url: string,
  init: { method: "POST" | "PATCH"; body: unknown },
  queue: { type: PendingActionType; payload: Record<string, unknown>; description: string },
): Promise<{ ok: boolean; queued: boolean; data: T }> {
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(init.body),
    });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { ok: res.ok, queued: false, data: data as T };
  } catch {
    // fetch() itself threw: no LAN / server unreachable, not a server-side rejection.
    await enqueueAction({ type: queue.type, payload: queue.payload, occurredAt: new Date().toISOString(), description: queue.description });
    return { ok: true, queued: true, data: {} as T };
  }
}

let flushing = false;

/**
 * Whether the server on this origin is actually answering.
 *
 * `navigator.onLine` only says the device has a network interface up — it is
 * true on a captive Wi-Fi portal, true when the hosting edge is returning 502,
 * and true when the container was replaced mid-session. Deployments behind a
 * managed platform therefore showed "اتصال به سرور قطع است" (or the inverse:
 * a green dot with every write failing) with nothing able to correct it,
 * because no code ever asked the server. This does, against /api/health, which
 * needs no session and touches no database.
 *
 * `onLine === false` is still trusted immediately in the negative direction:
 * the browser is authoritative that there is no network at all, and skipping
 * the probe there avoids a guaranteed-failing request every few seconds.
 */
export async function probeServer(): Promise<boolean> {
  // Never short-circuit on navigator.onLine: a phone can have no Internet and
  // still have a perfectly healthy route to the Business Suite PC over Wi-Fi.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch("/api/health", {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/** Sends every queued action to the server in FIFO order; removes what the server accepted (applied or a flagged conflict — either way there's nothing left to retry). */
export async function flushQueue(): Promise<void> {
  if (flushing) return;
  // The queue targets this origin (usually the LAN PC), not the Internet.
  // navigator.onLine=false must not suppress a flush while local Wi-Fi works.
  const db = getOfflineDb();
  const pending = await db.pendingActions.orderBy("createdAt").toArray();
  if (pending.length === 0) return;

  flushing = true;
  try {
    const res = await fetch("/api/sync/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: pending.map((p) => ({ clientEventId: p.id, type: p.type, occurredAt: p.occurredAt, payload: p.payload })),
      }),
    });
    if (!res.ok) return;
    const { results } = (await res.json()) as {
      results: { clientEventId: string; ok: boolean; conflict?: boolean }[];
    };
    const settled = new Set(results.filter((r) => r.ok || r.conflict).map((r) => r.clientEventId));
    for (const p of pending) {
      if (settled.has(p.id)) await db.pendingActions.delete(p.id);
    }
  } catch {
    // still offline, or the server just went down mid-flush — leave queued, try again later
  } finally {
    flushing = false;
    notifyListeners();
  }
}

export type LocalServerState = "local_server_connected" | "local_server_unreachable";
export type InternetState = "internet_available" | "internet_unavailable" | "internet_unknown";
export type CloudSyncState =
  | "cloud_sync_connected"
  | "cloud_sync_connecting"
  | "cloud_sync_paused"
  | "cloud_sync_not_configured";

export interface ConnectionState {
  localServer: LocalServerState;
  internet: InternetState;
  cloudSync: CloudSyncState;
  pendingActions: number;
  syncError: boolean;
}

export function useOfflineQueue(): { pendingCount: number; isOnline: boolean; connectionState: ConnectionState } {
  const [pendingCount, setPendingCount] = useState(0);
  const [isOnline, setIsOnline] = useState(true);
  const [internet, setInternet] = useState<InternetState>("internet_unknown");
  const [cloudSync, setCloudSync] = useState<CloudSyncState>("cloud_sync_not_configured");
  const [syncError, setSyncError] = useState(false);

  const refreshCount = useCallback(() => {
    void getOfflineDb().pendingActions.count().then(setPendingCount);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshCount();
    listeners.add(refreshCount);

    async function refreshOnlineState() {
      const reachable = await probeServer();
      if (cancelled) return;
      setIsOnline(reachable);
      if (!reachable) {
        // navigator.onLine only contributes to Internet state. It never decides
        // whether the same-origin local server can be reached.
        setInternet(navigator.onLine ? "internet_unknown" : "internet_unavailable");
        return;
      }
      await flushQueue();
      try {
        const response = await fetch("/api/connection/status", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { cloudSync?: string; error?: string | null };
        if (body.cloudSync === "connected") {
          setCloudSync("cloud_sync_connected");
          setInternet("internet_available");
          setSyncError(false);
        } else if (body.cloudSync === "connecting") {
          setCloudSync("cloud_sync_connecting");
          setInternet(navigator.onLine ? "internet_unknown" : "internet_unavailable");
          setSyncError(false);
        } else if (body.cloudSync === "paused") {
          setCloudSync("cloud_sync_paused");
          setInternet(navigator.onLine ? "internet_unknown" : "internet_unavailable");
          setSyncError(Boolean(body.error));
        } else {
          setCloudSync("cloud_sync_not_configured");
          setInternet(navigator.onLine ? "internet_unknown" : "internet_unavailable");
          setSyncError(false);
        }
      } catch {
        // The health request succeeded, so this is not a local-server outage.
        // Keep cloud state conservative until the next probe.
      }
    }

    function onNetworkChange() {
      void refreshOnlineState();
    }
    window.addEventListener("online", onNetworkChange);
    window.addEventListener("offline", onNetworkChange);

    void refreshOnlineState();
    const interval = setInterval(() => void refreshOnlineState(), 15_000);

    return () => {
      cancelled = true;
      listeners.delete(refreshCount);
      window.removeEventListener("online", onNetworkChange);
      window.removeEventListener("offline", onNetworkChange);
      clearInterval(interval);
    };
  }, [refreshCount]);

  return {
    pendingCount,
    isOnline,
    connectionState: {
      localServer: isOnline ? "local_server_connected" : "local_server_unreachable",
      internet,
      cloudSync,
      pendingActions: pendingCount,
      syncError,
    },
  };
}

export type { PendingAction };
