import { NextRequest, NextResponse } from "next/server";
import { applySyncEvent, type SyncEventInput, type SyncEventType } from "@/lib/sync-events";
import { query } from "@/lib/db";
import type { Role } from "@/lib/auth";

/**
 * Server-to-server push endpoint (Phase 11).
 * The local (café laptop) server POSTs its unsynced sync_events here.
 * Auth: Bearer token stored in REMOTE_SYNC_TOKEN env var on this server.
 * The same applySyncEvent() engine handles idempotency and conflict resolution.
 */

const VALID_TYPES: SyncEventType[] = ["order.create", "order.add_items", "order_item.status"];

function getToken(): string | null {
  return process.env.REMOTE_SYNC_TOKEN?.trim() || null;
}

interface IncomingEvent {
  clientEventId?: unknown;
  type?: unknown;
  occurredAt?: unknown;
  payload?: unknown;
  locationId?: unknown;
  actorUserId?: unknown;
  actorRole?: unknown;
}

export async function POST(request: NextRequest) {
  const token = getToken();
  if (!token) {
    return NextResponse.json({ error: "server_sync_not_configured" }, { status: 503 });
  }

  const auth = request.headers.get("authorization");
  if (!auth || auth !== `Bearer ${token}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { events?: IncomingEvent[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const events = body.events ?? [];
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ error: "no_events" }, { status: 400 });
  }
  if (events.length > 200) {
    return NextResponse.json({ error: "too_many_events" }, { status: 400 });
  }

  for (const e of events) {
    if (
      typeof e.clientEventId !== "string" || !e.clientEventId ||
      typeof e.occurredAt !== "string" ||
      !e.type || !VALID_TYPES.includes(e.type as SyncEventType) ||
      typeof e.payload !== "object" || e.payload === null ||
      typeof e.locationId !== "string" || !e.locationId ||
      typeof e.actorUserId !== "string" ||
      typeof e.actorRole !== "string"
    ) {
      return NextResponse.json({ error: "invalid_event" }, { status: 400 });
    }
  }

  // Verify all locationIds belong to a known business (basic tenant guard)
  const locationIds = [...new Set(events.map((e) => e.locationId as string))];
  const { rows: locRows } = await query<{ id: string }>(
    `SELECT id FROM locations WHERE id = ANY($1::uuid[])`,
    [locationIds],
  );
  const knownLocations = new Set(locRows.map((r) => r.id));
  for (const id of locationIds) {
    if (!knownLocations.has(id)) {
      return NextResponse.json({ error: "unknown_location", locationId: id }, { status: 422 });
    }
  }

  const results = [];
  for (const e of events) {
    const input: SyncEventInput = {
      clientEventId: e.clientEventId as string,
      type: e.type as SyncEventType,
      occurredAt: e.occurredAt as string,
      payload: e.payload as Record<string, unknown>,
    };
    results.push(
      await applySyncEvent(
        e.locationId as string,
        { userId: e.actorUserId as string, role: e.actorRole as Role },
        input,
        "remote",
      ),
    );
  }

  return NextResponse.json({ results });
}
