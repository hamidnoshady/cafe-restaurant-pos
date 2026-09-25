/**
 * سیستم ادواری — the /api/inventory/periodic-closings handlers: role gate,
 * body validation, the error → HTTP status map, and the transaction
 * discipline (COMMIT on success, ROLLBACK + release on every failure).
 * The service itself is mocked; its own behaviour is pinned in
 * periodic-closing-service.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import * as service from "@/lib/periodic-closing-service";
import { MissingLedgerAccountError } from "@/lib/ledger-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    // The scope wrapper is identity here — tenancy is not what this file tests.
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, getPool: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/periodic-closing-service", () => ({
  createPeriodicClosing: vi.fn(),
  listPeriodicClosings: vi.fn(),
}));

const SESSION = { businessId: "biz-1", sub: "user-1" };

function mockClient() {
  return { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
}

let client: ReturnType<typeof mockClient>;

beforeEach(() => {
  vi.clearAllMocks();
  client = mockClient();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(db.getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
});

function postRequest(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID_BODY = {
  periodEnd: "2026-01-31",
  lines: [{ inventoryItemId: "item-a", countedQty: "4" }],
};

describe("GET /api/inventory/periodic-closings", () => {
  it("returns the branch's closings and releases the client", async () => {
    const rows = [{ id: "c-1", periodEnd: "2026-01-31" }];
    vi.mocked(service.listPeriodicClosings).mockResolvedValue(rows as never);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closings: rows });
    expect(service.listPeriodicClosings).toHaveBeenCalledWith(client, "loc-1");
    expect(client.release).toHaveBeenCalled();
  });

  it("returns the role gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    expect(await GET()).toBe(denied);
    expect(db.getPool).not.toHaveBeenCalled();
  });

  it("answers an unresolved branch with an empty list, not an error", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await GET();
    expect(await response.json()).toEqual({ closings: [] });
    expect(db.getPool).not.toHaveBeenCalled();
  });
});

describe("POST /api/inventory/periodic-closings", () => {
  it("creates the closing inside a committed transaction", async () => {
    vi.mocked(service.createPeriodicClosing).mockResolvedValue({
      id: "closing-1",
      beginningValueRial: "0",
      purchasesValueRial: "1000",
      endingValueRial: "400",
      cogsValueRial: "600",
    });

    const response = await POST(postRequest({ ...VALID_BODY, note: "دی" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      id: "closing-1",
      beginningValueRial: "0",
      purchasesValueRial: "1000",
      endingValueRial: "400",
      cogsValueRial: "600",
    });

    expect(service.createPeriodicClosing).toHaveBeenCalledWith(client, {
      businessId: "biz-1",
      locationId: "loc-1",
      periodEnd: "2026-01-31",
      note: "دی",
      lines: VALID_BODY.lines,
      createdBy: "user-1",
    });
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });

  it("rejects a non-JSON body as bad_request", async () => {
    const request = { json: async () => { throw new Error("boom"); } } as unknown as NextRequest;
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
  });

  it("rejects a missing period end and an empty count before opening a transaction", async () => {
    const noEnd = await POST(postRequest({ lines: VALID_BODY.lines }));
    expect(noEnd.status).toBe(400);
    expect(await noEnd.json()).toEqual({ error: "invalid_period_end" });

    const noLines = await POST(postRequest({ periodEnd: "2026-01-31" }));
    expect(noLines.status).toBe(400);
    expect(await noLines.json()).toEqual({ error: "no_items" });

    expect(db.getPool).not.toHaveBeenCalled();
  });

  it("answers an unresolved branch with 409 no_location", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null as never);
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_location" });
  });

  it.each([
    ["invalid_period_end", 400],
    ["no_items", 400],
    ["invalid_item", 400],
    ["item_not_found", 400],
    ["not_periodic_system", 409],
    ["period_end_not_after_previous", 409],
  ] as const)("maps %s from the service to %i and rolls back", async (code, status) => {
    vi.mocked(service.createPeriodicClosing).mockRejectedValue(new Error(code));
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });

  it("strips the item id off count_line_missing (it names the item internally, not to the wire)", async () => {
    vi.mocked(service.createPeriodicClosing).mockRejectedValue(new Error("count_line_missing: item-b"));
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "count_line_missing" });
  });

  it("maps a missing ledger account to 409 with the account code", async () => {
    vi.mocked(service.createPeriodicClosing).mockRejectedValue(new MissingLedgerAccountError("5105"));
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "ledger_account_missing", code: "5105" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rethrows an unknown error after rolling back and releasing", async () => {
    vi.mocked(service.createPeriodicClosing).mockRejectedValue(new Error("connection lost"));
    await expect(POST(postRequest(VALID_BODY))).rejects.toThrow("connection lost");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});
