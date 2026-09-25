/**
 * POST /api/sync/events — the offline-queue flush endpoint. These tests pin
 * the eligibility gate this route now applies (Section 5 offline-queue
 * audit extension, `isOfflineQueueEligible`): the three legacy order actions
 * and `inventory.waste.recorded` may flush here; a transactional definition
 * that exists in the sync-event registry but was never opted into the
 * client's offline queue (e.g. a payment or a purchase) must still be
 * rejected as `invalid_event`, even though `syncEventDefinition` recognises
 * it. `applySyncEvent` itself is mocked; its behaviour is pinned in
 * sync-events.ts's own tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as syncEvents from "@/lib/sync-events";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireMember: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/sync-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync-events")>();
  return { ...actual, applySyncEvent: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const LOCATION_ID = "loc-1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireMember).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: LOCATION_ID } as never);
  vi.mocked(syncEvents.applySyncEvent).mockResolvedValue({ clientEventId: "evt-1", ok: true, data: {} });
});

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/sync/events", () => {
  it("applies a legacy order action", async () => {
    const res = await POST(
      postRequest({
        events: [{ clientEventId: "evt-1", type: "order.create", occurredAt: new Date().toISOString(), payload: { type: "dine_in" } }],
      }),
    );
    expect(res.status).toBe(200);
    expect(syncEvents.applySyncEvent).toHaveBeenCalledWith(LOCATION_ID, { userId: SESSION.sub, role: SESSION.role }, expect.objectContaining({ type: "order.create" }));
  });

  it("applies inventory.waste.recorded — the one domain explicitly opened to the offline queue", async () => {
    const res = await POST(
      postRequest({
        events: [
          {
            clientEventId: "evt-2",
            type: "inventory.waste.recorded",
            occurredAt: new Date().toISOString(),
            payload: { inventoryItemId: "item-1", quantity: "1", reason: "spoilage", note: null },
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(syncEvents.applySyncEvent).toHaveBeenCalledTimes(1);
  });

  it("rejects a transactional event type that exists in the registry but was never opted into the offline queue", async () => {
    const res = await POST(
      postRequest({
        events: [
          {
            clientEventId: "evt-3",
            type: "order.payment.completed",
            occurredAt: new Date().toISOString(),
            payload: { orderId: "ord-1", method: "cash" },
          },
        ],
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_event");
    expect(syncEvents.applySyncEvent).not.toHaveBeenCalled();
  });

  it("rejects a completely unknown event type", async () => {
    const res = await POST(
      postRequest({
        events: [{ clientEventId: "evt-4", type: "not.a.real.type", occurredAt: new Date().toISOString(), payload: {} }],
      }),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_event");
  });
});
