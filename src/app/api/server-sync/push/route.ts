import { NextRequest, NextResponse } from "next/server";
import { applySyncEvent, type SyncEventInput, type SyncEventType } from "@/lib/sync-events";
import { query, withTenant, withoutTenantScope } from "@/lib/db";
import { recordLegacyTokenUsage, resolveBusinessBySyncToken, tokensMatch, legacySyncToken } from "@/lib/server-sync";
import type { Role } from "@/lib/auth";

/**
 * Server-to-server push endpoint (Phase 11).
 * The local (café laptop) server POSTs its unsynced sync_events here.
 * The same applySyncEvent() engine handles idempotency and conflict resolution.
 *
 * Phase 17 security review: authenticates against a per-business token first
 * (server_sync_tokens, set alongside a business's own server-sync config) —
 * this resolves *which* business the request is for, closing the hole where
 * one shared REMOTE_SYNC_TOKEN would otherwise authenticate as every business
 * on this server. The env var stays as a legacy fallback for anyone who
 * hasn't configured a per-business token yet; even then, the business is
 * derived from the events' own locations (required to all agree) and every
 * write is wrapped in withTenant() explicitly, rather than assuming RLS alone
 * scopes it correctly.
 */

const VALID_TYPES: SyncEventType[] = ["order.create", "order.add_items", "order_item.status"];

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
  const auth = request.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let tokenBusinessId = await resolveBusinessBySyncToken(bearer);
  let usedLegacyToken = false;
  if (!tokenBusinessId) {
    const legacy = legacySyncToken();
    if (!legacy || !tokensMatch(bearer, legacy)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    usedLegacyToken = true;
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

  // Resolve every referenced location's business — before any tenant scope
  // exists, the same as the token lookup above — and require they all agree,
  // so one push request can never touch more than one business's data.
  const locationIds = [...new Set(events.map((e) => e.locationId as string))];
  const { rows: locRows } = await withoutTenantScope("server-sync-auth", () =>
    query<{ id: string; business_id: string }>(
      `SELECT id, business_id FROM locations WHERE id = ANY($1::uuid[])`,
      [locationIds],
    ),
  );
  const businessByLocation = new Map(locRows.map((r) => [r.id, r.business_id]));
  for (const id of locationIds) {
    if (!businessByLocation.has(id)) {
      return NextResponse.json({ error: "unknown_location", locationId: id }, { status: 422 });
    }
  }
  const eventBusinessIds = new Set(businessByLocation.values());
  if (eventBusinessIds.size > 1) {
    return NextResponse.json({ error: "mixed_business_locations" }, { status: 422 });
  }
  const eventsBusinessId = [...eventBusinessIds][0];
  
  if (usedLegacyToken) {
    const { rows } = await withoutTenantScope("server-sync-auth", () =>
      query(`SELECT 1 FROM server_sync_tokens WHERE business_id = $1`, [eventsBusinessId])
    );
    if (rows.length > 0) {
      return NextResponse.json({ error: "legacy_token_superseded" }, { status: 403 });
    }
  }

  if (tokenBusinessId && tokenBusinessId !== eventsBusinessId) {
    return NextResponse.json({ error: "location_business_mismatch" }, { status: 403 });
  }
  const businessId = tokenBusinessId ?? eventsBusinessId;

  const results = await withTenant(businessId, async () => {
    if (usedLegacyToken) await recordLegacyTokenUsage(businessId);
    const out = [];
    for (const e of events) {
      const input: SyncEventInput = {
        clientEventId: e.clientEventId as string,
        type: e.type as SyncEventType,
        occurredAt: e.occurredAt as string,
        payload: e.payload as Record<string, unknown>,
      };
      out.push(
        await applySyncEvent(
          e.locationId as string,
          { userId: e.actorUserId as string, role: e.actorRole as Role },
          input,
          "remote",
        ),
      );
    }
    return out;
  });

  return NextResponse.json({ results });
}
