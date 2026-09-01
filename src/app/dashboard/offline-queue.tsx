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
  if (typeof navigator !== "undefined" && !navigator.onLine) return false;
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
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
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

export function useOfflineQueue(): { pendingCount: number; isOnline: boolean } {
  const [pendingCount, setPendingCount] = useState(0);
  const [isOnline, setIsOnline] = useState(true);

  const refreshCount = useCallback(() => {
    void getOfflineDb().pendingActions.count().then(setPendingCount);
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshCount();
    listeners.add(refreshCount);

    // The probe, not `navigator.onLine`, decides what the banner says — see
    // probeServer() above for why the browser's own flag is not enough. The
    // flag is still used as a *trigger*, because it fires the instant the NIC
    // comes back and saves waiting out the poll interval.
    async function refreshOnlineState() {
      const reachable = await probeServer();
      if (cancelled) return;
      setIsOnline(reachable);
      if (reachable) await flushQueue();
    }

    function onOnline() {
      void refreshOnlineState();
    }
    function onOffline() {
      setIsOnline(false);
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    void refreshOnlineState();
    const interval = setInterval(() => void refreshOnlineState(), 15_000);

    return () => {
      cancelled = true;
      listeners.delete(refreshCount);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      clearInterval(interval);
    };
  }, [refreshCount]);

  return { pendingCount, isOnline };
}

export type { PendingAction };
