/**
 * GET /api/print/health — the fallback the browser's print client hits when
 * no loopback agent answers. Pins the role gate and the response contract
 * the client's checkAgent() parses (ok/platform/version/source).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireRole).mockResolvedValue({ session: { businessId: "biz-1" }, error: null } as never);
});

describe("GET /api/print/health", () => {
  it("answers with the contract checkAgent() parses, tagged source=server", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, platform: process.platform, version: 2, source: "server" });
    expect(auth.requireRole).toHaveBeenCalledWith("owner", "manager", "cashier", "waiter", "kitchen");
  });

  it("returns the role gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    vi.mocked(auth.requireRole).mockResolvedValue({ session: null, error: denied } as never);
    expect((await GET()).status).toBe(401);
  });
});
