/**
 * POST /api/print/render — the server half of the `webusb` transport: render
 * a job to raw ESC/POS bytes and return them as an octet-stream for the
 * browser to push down the USB cable. Pins the role gate, the body shapes,
 * that the SUCCESS response is the raw bytes (not JSON), and that a render
 * failure comes back as JSON 502. buildJobBytes itself is pinned in
 * system-print/service.test.ts.
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
  buildJobBytes: vi.fn(),
}));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "cashier" };
const CONNECTION = { transport: "webusb", usbVendorId: 0x04b8, usbProductId: 0x0e15 };
const BYTES = Buffer.from([0x1b, 0x40, 0x1d, 0x56, 0x01]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireRole).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(service.buildJobBytes).mockResolvedValue(BYTES);
});

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("guards and validation", () => {
  it("gates on the same print-triggering roles as /api/print/job", async () => {
    await POST(request({ op: "test", connection: CONNECTION }));
    expect(auth.requireRole).toHaveBeenCalledWith("owner", "manager", "cashier", "waiter", "kitchen");
  });

  it("returns the role gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requireRole).mockResolvedValue({ session: null, error: denied } as never);
    expect((await POST(request({ op: "test", connection: CONNECTION }))).status).toBe(403);
    expect(service.buildJobBytes).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body, a bad connection, and an unknown op", async () => {
    const bad = { json: async () => Promise.reject(new Error("boom")) } as unknown as NextRequest;
    expect((await POST(bad)).status).toBe(400);
    expect((await POST(request({ op: "test", connection: { transport: "webusb" } }))).status).toBe(400);
    expect((await POST(request({ op: "fax", connection: CONNECTION }))).status).toBe(400);
  });

  it("document requires html and caps its size", async () => {
    const missing = await POST(request({ op: "document", connection: CONNECTION }));
    expect(missing.status).toBe(400);
    const huge = await POST(request({ op: "document", connection: CONNECTION, html: "x".repeat(8_000_001) }));
    expect(huge.status).toBe(413);
  });

  it("receipt / kitchen-ticket / label require their payloads", async () => {
    expect((await POST(request({ op: "receipt", connection: CONNECTION }))).status).toBe(400);
    expect((await POST(request({ op: "kitchen-ticket", connection: CONNECTION }))).status).toBe(400);
    expect((await POST(request({ op: "label", connection: CONNECTION }))).status).toBe(400);
  });
});

describe("rendering", () => {
  it("returns the job bytes verbatim as an uncacheable octet-stream", async () => {
    const response = await POST(request({ op: "receipt", connection: CONNECTION, receipt: { orderLabel: "#1" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
  });

  it("passes each op through as the matching RenderableJob", async () => {
    await POST(request({ op: "document", connection: CONNECTION, html: "<html></html>", paper: "thermal58" }));
    expect(service.buildJobBytes).toHaveBeenLastCalledWith(CONNECTION, {
      op: "document",
      html: "<html></html>",
      paper: "thermal58",
    });

    await POST(request({ op: "document", connection: CONNECTION, html: "<html></html>", paper: "nonsense" }));
    expect(vi.mocked(service.buildJobBytes).mock.calls.at(-1)![1]).toEqual({
      op: "document",
      html: "<html></html>",
      paper: undefined,
    });

    await POST(request({ op: "test", connection: CONNECTION, kind: "kitchen" }));
    expect(service.buildJobBytes).toHaveBeenLastCalledWith(CONNECTION, { op: "test", kind: "kitchen" });

    await POST(request({ op: "drawer-kick", connection: CONNECTION }));
    expect(service.buildJobBytes).toHaveBeenLastCalledWith(CONNECTION, { op: "drawer-kick" });
  });

  it("maps a render failure to JSON 502 with the error's message", async () => {
    vi.mocked(service.buildJobBytes).mockRejectedValue(new Error("sheet_printing_needs_a_system_printer"));
    const response = await POST(request({ op: "document", connection: CONNECTION, html: "<html></html>", paper: "a4" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: "sheet_printing_needs_a_system_printer" });
  });
});
