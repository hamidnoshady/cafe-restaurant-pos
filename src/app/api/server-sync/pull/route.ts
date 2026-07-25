import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";

/**
 * Server-to-server pull endpoint (Phase 11).
 * The local (café laptop) server GETs events from here that it hasn't seen yet.
 * Auth: Bearer token stored in REMOTE_SYNC_TOKEN env var on this server.
 * Returns sync_events rows with origin='local' (never bounces remote-origin events back).
 */

function getToken(): string | null {
  return process.env.REMOTE_SYNC_TOKEN?.trim() || null;
}

type SyncEventRow = {
  id: number;
  location_id: string;
  client_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_role: string | null;
};

export async function GET(request: NextRequest) {
  const token = getToken();
  if (!token) {
    return NextResponse.json({ error: "server_sync_not_configured" }, { status: 503 });
  }

  const auth = request.headers.get("authorization");
  if (!auth || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const after = Number(searchParams.get("after") ?? "0");
  const limit = Math.min(Number(searchParams.get("limit") ?? "100"), 200);

  if (!Number.isFinite(after) || !Number.isFinite(limit)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { rows } = await query<SyncEventRow>(
    `SELECT se.id, se.location_id, se.client_event_id, se.event_type,
            se.payload, se.occurred_at, se.actor_user_id, se.actor_role
       FROM sync_events se
      WHERE se.id > $1
        AND se.applied_at IS NOT NULL
        AND se.error IS NULL
        AND (se.origin IS NULL OR se.origin = 'local')
      ORDER BY se.id
      LIMIT $2`,
    [after, limit],
  );

  const events = rows.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    clientEventId: r.client_event_id,
    type: r.event_type,
    payload: r.payload,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : r.occurred_at,
    actorUserId: r.actor_user_id ?? "",
    actorRole: r.actor_role ?? "cashier",
  }));

  return NextResponse.json({ events });
}
