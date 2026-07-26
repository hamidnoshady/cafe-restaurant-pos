import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { resolveActiveLocation } from "@/lib/setup-state";
import { applySyncEvent, type SyncEventInput, type SyncEventType } from "@/lib/sync-events";

/**
 * Offline-queue flush endpoint (Phase 5): a client that queued actions in
 * its local IndexedDB (src/lib/offline-db.ts) while it couldn't reach the
 * server POSTs them here, in the order it queued them, once reconnected.
 * Every role that can take an order/kitchen action while connected can also
 * replay one here — sync-events.ts enforces the same per-event-type
 * permissions the synchronous routes do.
 */
export async function POST(request: NextRequest) {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  let body: { events?: Partial<SyncEventInput>[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const events = body.events ?? [];
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ error: "no_events" }, { status: 400 });
  }
  if (events.length > 100) {
    return NextResponse.json({ error: "too_many_events" }, { status: 400 });
  }

  const VALID_TYPES: SyncEventType[] = ["order.create", "order.add_items", "order_item.status"];
  for (const e of events) {
    if (
      typeof e.clientEventId !== "string" ||
      !e.clientEventId ||
      typeof e.occurredAt !== "string" ||
      !e.type ||
      !VALID_TYPES.includes(e.type) ||
      typeof e.payload !== "object" ||
      e.payload === null
    ) {
      return NextResponse.json({ error: "invalid_event" }, { status: 400 });
    }
  }

  // Applied sequentially (not Promise.all): later events in the batch may
  // depend on earlier ones (e.g. "add items" to an order created earlier in
  // the same flush), and replay order is how conflicts get resolved
  // deterministically (offline-sync.ts).
  const results = [];
  for (const e of events as SyncEventInput[]) {
    results.push(await applySyncEvent(location.id, { userId: session.sub, role: session.role }, e));
  }

  return NextResponse.json({ results });
}
