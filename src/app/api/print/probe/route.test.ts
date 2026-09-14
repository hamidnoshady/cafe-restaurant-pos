/**
 * POST /api/print/probe — "is this printer answering right now, as seen from
 * the app server?" Pins the role gate, the connection validation, and that
 * the service's probe verdict is spread into the JSON answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/system-print/service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/system-print/service", () => ({
  probeConnection: vi.fn(),
}));

const CONNECTION = { transport: "network", ip: "10.0.0.5", port: 9100 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireRole).mockResolvedValue({ session: { businessId: "biz-1" }, error: null } as never);
});

function request(body: unknown): NextRequest {
  if (body === undefined) return { json: async () => Promise.reject(new Error("no body")) } as unknown as NextRequest;
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/print/probe", () => {
  it("spreads the service's verdict into the answer", async () => {
    vi.mocked(service.probeConnection).mockResolvedValue({ reachable: true, detail: "12ms" } as never);
    const response = await POST(request({ connection: CONNECTION }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, reachable: true, detail: "12ms" });
    expect(service.probeConnection).toHaveBeenCalledWith(CONNECTION);
    expect(auth.requireRole).toHaveBeenCalledWith("owner", "manager", "cashier", "waiter", "kitchen");
  });

  it("returns the role gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    vi.mocked(auth.requireRole).mockResolvedValue({ session: null, error: denied } as never);
    expect((await POST(request({ connection: CONNECTION }))).status).toBe(401);
    expect(service.probeConnection).not.toHaveBeenCalled();
  });

  it("rejects a missing body and an invalid connection with 400", async () => {
    const noBody = await POST(request(undefined));
    expect(noBody.status).toBe(400);
    expect(await noBody.json()).toMatchObject({ error: "bad_request" });

    for (const connection of [undefined, {}, { transport: "network", ip: "" }]) {
      const response = await POST(request({ connection }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_connection" });
    }
    expect(service.probeConnection).not.toHaveBeenCalled();
  });
});
