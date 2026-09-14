/**
 * POST /api/print/scan — the server-side LAN sweep. Pins the settingsManage
 * gate and the request-shaping the route promises: at most 4 subnets and 4
 * ports reach the service, the timeout is clamped to 100–1000ms (a patient
 * sweep is the agent's job, this one runs inside an HTTP request), and a
 * missing body means "sweep the server's own subnets with the defaults".
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
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/system-print/service", () => ({
  scanLanPrinters: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "biz-1" }, error: null } as never);
  vi.mocked(service.scanLanPrinters).mockResolvedValue([]);
});

function request(body: unknown): NextRequest {
  if (body === undefined) return { json: async () => Promise.reject(new Error("no body")) } as unknown as NextRequest;
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/print/scan", () => {
  it("returns the sweep's findings, gated on settingsManage", async () => {
    const printers = [{ ip: "10.0.0.7", port: 9100, latencyMs: 4 }];
    vi.mocked(service.scanLanPrinters).mockResolvedValue(printers as never);
    const response = await POST(request({ subnets: ["10.0.0"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, printers });
    expect(auth.requirePermission).toHaveBeenCalledWith(expect.anything());
  });

  it("returns the permission gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    expect((await POST(request({}))).status).toBe(403);
    expect(service.scanLanPrinters).not.toHaveBeenCalled();
  });

  it("caps the sweep at 4 subnets and 4 ports and clamps the timeout into 100–1000ms", async () => {
    await POST(
      request({
        subnets: ["10.0.0", "10.0.1", "10.0.2", "10.0.3", "10.0.4", "10.0.5"],
        ports: [9100, 515, 631, 6001, 6002],
        timeoutMs: 30_000,
      }),
    );
    expect(service.scanLanPrinters).toHaveBeenCalledWith({
      subnets: ["10.0.0", "10.0.1", "10.0.2", "10.0.3"],
      ports: [9100, 515, 631, 6001],
      timeoutMs: 1000,
    });

    await POST(request({ timeoutMs: 1 }));
    expect(vi.mocked(service.scanLanPrinters).mock.calls.at(-1)![0]).toMatchObject({ timeoutMs: 100 });
  });

  it("a missing or empty body sweeps the server's own subnets with the defaults", async () => {
    await POST(request(undefined));
    expect(service.scanLanPrinters).toHaveBeenLastCalledWith({
      subnets: undefined,
      ports: undefined,
      timeoutMs: undefined,
    });
  });
});
