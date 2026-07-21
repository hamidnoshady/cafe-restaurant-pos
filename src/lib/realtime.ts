/**
 * Server-side WebSocket registry for live sync (Phase 4): the custom server
 * (server.ts) accepts `/ws` upgrades and hands each authenticated socket to
 * `registerConnection`; API route handlers call `broadcast` after a mutation
 * commits so every connected cashier/waiter/KDS screen updates within ~1s.
 *
 * Not unit-tested — like db.ts, this touches a live connection registry
 * rather than pure logic. Scoped to one location: v1 is single-location, and
 * a null `locationId` on a connection (owner/roaming manager) receives every
 * location's events.
 */
import type { WebSocket } from "ws";
import type { SessionPayload } from "./auth";

export type RealtimeEvent =
  | { type: "order.created"; orderId: string }
  | { type: "order.updated"; orderId: string }
  | { type: "order.item_status"; orderId: string; itemId: string; status: string }
  | { type: "table.status"; tableId: string; status: string }
  | { type: "table_session.updated"; sessionId: string };

interface Connection {
  ws: WebSocket;
  session: SessionPayload;
}

// Cached on globalThis so dev-mode hot reload of this module doesn't spawn a
// second, disconnected registry (same pattern as getPool() in db.ts).
const globalForRt = globalThis as unknown as { rtConnections?: Set<Connection> };
const connections = globalForRt.rtConnections ?? (globalForRt.rtConnections = new Set());

export function registerConnection(ws: WebSocket, session: SessionPayload): void {
  const conn: Connection = { ws, session };
  connections.add(conn);
  ws.on("close", () => connections.delete(conn));
  ws.on("error", () => connections.delete(conn));
}

/** Sends `event` to every connected client scoped to `locationId` (or all-location owners/managers). */
export function broadcast(locationId: string, event: RealtimeEvent): void {
  const payload = JSON.stringify(event);
  for (const { ws, session } of connections) {
    if (session.locationId !== null && session.locationId !== locationId) continue;
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}

export function connectionCount(): number {
  return connections.size;
}
