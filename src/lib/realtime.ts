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
  | { type: "table_session.updated"; sessionId: string }
  | {
      type: "inventory.low_stock";
      inventoryItemId: string;
      name: string;
      quantity: number;
      reorderLevel: number;
    };

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

  // Phase 24: Periodic re-authorization for long-lived sockets
  const REAUTH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const interval = setInterval(async () => {
    // Dynamic import to avoid circular dependencies
    const { resolveSessionFromToken } = await import("./auth");
    
    // We can't access the raw token anymore, but we can just use the DB to check if the session is still active
    // Alternatively, we can check the db directly. Wait, resolveSessionFromToken requires the token.
    // Let's just check the DB to ensure they still have the role/permission, or if their employee session is revoked.
    try {
      const { query } = await import("./db");
      
      if (session.employeeSessionId) {
        const { rows } = await query<{ revoked_at: Date | null }>(
          `SELECT revoked_at FROM employee_sessions WHERE id = $1`,
          [session.employeeSessionId]
        );
        if (rows.length === 0 || rows[0].revoked_at !== null) {
          ws.close(1008, "Session Revoked");
          return;
        }
      }

      if (session.platformUserId && session.tokenVersion) {
        const { rows } = await query<{ token_version: number }>(
          `SELECT token_version FROM platform_users WHERE id = $1`,
          [session.platformUserId]
        );
        if (rows.length === 0 || rows[0].token_version !== session.tokenVersion) {
          ws.close(1008, "Session Revoked");
          return;
        }
      }

    } catch (e) {
      console.error("Re-auth failed:", e);
      ws.close(1011, "Internal Error");
    }
  }, REAUTH_INTERVAL_MS);
  
  interval.unref();

  ws.on("close", () => clearInterval(interval));
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
