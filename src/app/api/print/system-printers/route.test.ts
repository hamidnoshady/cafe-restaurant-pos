/**
 * GET /api/print/system-printers — the server-side twin of the agent's
 * GET /printers/system. Pins that it is gated on settingsManage (it reveals
 * host-machine details) and returns the service's queue list verbatim.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import * as service from "@/lib/system-print/service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/system-print/service", () => ({
  listSystemPrinters: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "biz-1" }, error: null } as never);
});

describe("GET /api/print/system-printers", () => {
  it("returns the host's print queues verbatim, gated on settingsManage", async () => {
    const printers = [
      { name: "EPSON TM-T20III", driver: "EPSON", port: "USB001", isDefault: true, status: null, likelyThermal: true },
    ];
    vi.mocked(service.listSystemPrinters).mockResolvedValue(printers as never);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, printers });
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.settingsManage);
  });

  it("returns the permission gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    expect((await GET()).status).toBe(403);
    expect(service.listSystemPrinters).not.toHaveBeenCalled();
  });
});
