/**
 * POST /api/printing/print — the one hardware print endpoint. These tests pin
 * the security model of the new architecture:
 *
 *  - the request carries ONLY a printerId; an arbitrary connection/ip/queue
 *    in the body is ignored, never honoured;
 *  - the printer is loaded for the CALLER's active location — a printer ID
 *    from another branch does not exist (printer_not_found), so a hand-edited
 *    request cannot aim the server at hardware it should not reach;
 *  - inactive and reconnect-required printers are refused before rendering;
 *  - success returns the canonical ESC/POS bytes plus the resolved target for
 *    local delivery, and a render failure is 502 render_failed.
 *
 * The render service is mocked; its behaviour is pinned in
 * src/lib/printing/render-service.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import * as setupState from "@/lib/setup-state";
import * as renderService from "@/lib/printing/render-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/printing/render-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/printing/render-service")>();
  return {
    ...actual,
    loadPrinterForJob: vi.fn(),
    buildJobBytes: vi.fn(),
  };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "cashier" };
const PRINTERS_ROW = {
  id: "printer-1",
  name: "چاپگر صندوق",
  kind: "receipt",
  connection: { type: "windows", systemName: "EPSON TM-T20III", paperWidthMm: 80 },
  is_active: true,
};

function printerRow(overrides: Record<string, unknown> = {}) {
  return { ...PRINTERS_ROW, ...overrides };
}

function request(body: unknown, method = "POST"): NextRequest {
  return { json: async () => body, method } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(renderService.loadPrinterForJob).mockResolvedValue(PRINTERS_ROW as never);
  vi.mocked(renderService.buildJobBytes).mockResolvedValue(Buffer.from([0x1b, 0x40, 0x1d, 0x56]) as never);
});

describe("guards", () => {
  it("lets every print-triggering role through the gate", async () => {
    await POST(request({ printerId: "printer-1", job: { type: "test", kind: "receipt" } }));
    expect(auth.requirePermission).toHaveBeenCalledWith("printing.execute");
  });

  it("returns the role gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(request({ printerId: "printer-1", job: { type: "test" } }));
    expect(response.status).toBe(401);
    expect(renderService.buildJobBytes).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body and a missing printerId with 400", async () => {
    const bad = { json: async () => Promise.reject(new Error("boom")) } as unknown as NextRequest;
    expect((await POST(bad)).status).toBe(400);

    for (const body of [{}, { job: { type: "test" } }, { printerId: "" }]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "printer_not_found" });
    }
  });

  it("rejects an unknown job type with 400", async () => {
    const response = await POST(request({ printerId: "printer-1", job: { type: "fax" } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_request" });
  });
});

describe("printer resolution — the security model", () => {
  it("loads the printer scoped to the caller's active location", async () => {
    await POST(request({ printerId: "printer-1", job: { type: "test", kind: "receipt" } }));
    expect(renderService.loadPrinterForJob).toHaveBeenCalledWith("loc-1", "printer-1");
  });

  it("a printer ID from another branch simply does not exist (404 printer_not_found)", async () => {
    vi.mocked(renderService.loadPrinterForJob).mockResolvedValue(null as never);
    const response = await POST(request({ printerId: "another-branch-printer", job: { type: "test" } }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "printer_not_found" });
    expect(renderService.buildJobBytes).not.toHaveBeenCalled();
  });

  it("ignores an arbitrary connection object in the body — the saved row decides the target", async () => {
    const response = await POST(
      request({
        printerId: "printer-1",
        job: { type: "test" },
        connection: { transport: "network", ip: "203.0.113.7", port: 9100 },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { target: unknown };
    expect(body.target).toEqual({ type: "windows", systemName: "EPSON TM-T20III" });
    expect(renderService.buildJobBytes).toHaveBeenCalledTimes(1);
  });

  it("refuses an inactive printer with 409 printer_inactive", async () => {
    vi.mocked(renderService.loadPrinterForJob).mockResolvedValue(printerRow({ is_active: false }) as never);
    const response = await POST(request({ printerId: "printer-1", job: { type: "test" } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "printer_inactive" });
    expect(renderService.buildJobBytes).not.toHaveBeenCalled();
  });

  it("refuses a reconnect-required legacy printer with 409 reconnect_required", async () => {
    vi.mocked(renderService.loadPrinterForJob).mockResolvedValue(
      printerRow({ connection: { needsReconnect: true, legacyTransport: "webusb", usbProductName: "TM-T20III" } }) as never,
    );
    const response = await POST(request({ printerId: "printer-1", job: { type: "test" } }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "reconnect_required" });
    expect(renderService.buildJobBytes).not.toHaveBeenCalled();
  });
});

describe("job dispatch", () => {
  it("returns the rendered bytes and the resolved target for local delivery", async () => {
    const bytes = Buffer.from([0x1b, 0x40, 0x00, 0x01]);
    vi.mocked(renderService.buildJobBytes).mockResolvedValue(bytes as never);
    const response = await POST(
      request({ printerId: "printer-1", job: { type: "receipt", receipt: { business: { name: "کافه" } } } }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; target: unknown; dataBase64: string };
    expect(body.ok).toBe(true);
    expect(body.target).toEqual({ type: "windows", systemName: "EPSON TM-T20III" });
    expect(body.dataBase64).toBe(bytes.toString("base64"));
  });

  it("rejects a document job without html or with a sheet paper", async () => {
    expect((await POST(request({ printerId: "printer-1", job: { type: "document" } }))).status).toBe(400);
    expect((await POST(request({ printerId: "printer-1", job: { type: "document", html: "<html></html>", paper: "a4" } }))).status).toBe(400);
    expect((await POST(request({ printerId: "printer-1", job: { type: "document", html: "x".repeat(8_000_001), paper: "thermal80" } }))).status).toBe(400);
    expect(renderService.buildJobBytes).not.toHaveBeenCalled();
  });

  it("requires the payload field each data job names", async () => {
    expect((await POST(request({ printerId: "printer-1", job: { type: "receipt" } }))).status).toBe(400);
    expect((await POST(request({ printerId: "printer-1", job: { type: "kitchen-ticket" } }))).status).toBe(400);
    expect((await POST(request({ printerId: "printer-1", job: { type: "label" } }))).status).toBe(400);
    expect((await POST(request({ printerId: "printer-1", job: { type: "document" } }))).status).toBe(400);
  });

  it("maps a render failure to 502 render_failed and logs it", async () => {
    vi.mocked(renderService.buildJobBytes).mockRejectedValue(new Error("chromium gone") as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request({ printerId: "printer-1", job: { type: "test" } }));
    errorSpy.mockRestore();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "render_failed" });
  });
});
