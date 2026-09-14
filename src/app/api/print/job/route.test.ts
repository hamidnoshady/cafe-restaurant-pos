/**
 * POST /api/print/job — the app server's twin of the print agent's /print/*
 * endpoints. These tests pin the role gate, the connection validation, the
 * op → service-function dispatch, the per-op required-field checks, and the
 * error → HTTP status map (400 shapes vs 502 printer failures). The service
 * itself is mocked; its behaviour is pinned in system-print/service.test.ts.
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
  printDocumentJob: vi.fn().mockResolvedValue(undefined),
  printReceiptJob: vi.fn().mockResolvedValue(undefined),
  printKitchenTicketJob: vi.fn().mockResolvedValue(undefined),
  printLabelJob: vi.fn().mockResolvedValue(undefined),
  printTestJob: vi.fn().mockResolvedValue(undefined),
  kickDrawerJob: vi.fn().mockResolvedValue(undefined),
}));

const SESSION = { businessId: "biz-1", sub: "user-1", role: "cashier" };
const CONNECTION = { transport: "network", ip: "10.0.0.5", port: 9100 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireRole).mockResolvedValue({ session: SESSION, error: null } as never);
});

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("guards and body validation", () => {
  it("lets every print-triggering role through the gate", async () => {
    await POST(request({ op: "test", connection: CONNECTION }));
    expect(auth.requireRole).toHaveBeenCalledWith("owner", "manager", "cashier", "waiter", "kitchen");
  });

  it("returns the role gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    vi.mocked(auth.requireRole).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(request({ op: "test", connection: CONNECTION }));
    expect(response.status).toBe(401);
    expect(service.printTestJob).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON body with 400", async () => {
    const bad = { json: async () => Promise.reject(new Error("boom")) } as unknown as NextRequest;
    const response = await POST(bad);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "bad_request" });
  });

  it("rejects a missing or invalid connection with 400", async () => {
    for (const connection of [undefined, {}, { transport: "network", ip: "" }, { transport: "webusb" }]) {
      const response = await POST(request({ op: "test", connection }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_connection" });
    }
    expect(service.printTestJob).not.toHaveBeenCalled();
  });

  it("rejects an unknown op with 400", async () => {
    const response = await POST(request({ op: "fax", connection: CONNECTION }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unknown_op" });
  });
});

describe("op dispatch", () => {
  it("document → printDocumentJob with the html and validated paper key", async () => {
    const response = await POST(
      request({ op: "document", connection: CONNECTION, html: "<html></html>", paper: "thermal80" }),
    );
    expect(response.status).toBe(200);
    expect(service.printDocumentJob).toHaveBeenCalledWith(CONNECTION, "<html></html>", "thermal80");
  });

  it("document drops an unknown paper key rather than passing it through", async () => {
    await POST(request({ op: "document", connection: CONNECTION, html: "<html></html>", paper: "a3" }));
    expect(service.printDocumentJob).toHaveBeenCalledWith(CONNECTION, "<html></html>", undefined);
  });

  it("document without html is 400, and an oversized html is 413", async () => {
    const missing = await POST(request({ op: "document", connection: CONNECTION }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "missing_html" });

    const huge = await POST(request({ op: "document", connection: CONNECTION, html: "x".repeat(8_000_001) }));
    expect(huge.status).toBe(413);
    expect(service.printDocumentJob).not.toHaveBeenCalled();
  });

  it("receipt / kitchen-ticket / label require their own payload field", async () => {
    expect((await POST(request({ op: "receipt", connection: CONNECTION }))).status).toBe(400);
    expect((await POST(request({ op: "kitchen-ticket", connection: CONNECTION }))).status).toBe(400);
    expect((await POST(request({ op: "label", connection: CONNECTION }))).status).toBe(400);

    const receipt = { orderLabel: "#1" };
    await POST(request({ op: "receipt", connection: CONNECTION, receipt }));
    expect(service.printReceiptJob).toHaveBeenCalledWith(CONNECTION, receipt);

    const ticket = { label: "میز ۲" };
    await POST(request({ op: "kitchen-ticket", connection: CONNECTION, ticket }));
    expect(service.printKitchenTicketJob).toHaveBeenCalledWith(CONNECTION, ticket);

    const label = { code: "123" };
    await POST(request({ op: "label", connection: CONNECTION, label }));
    expect(service.printLabelJob).toHaveBeenCalledWith(CONNECTION, label);
  });

  it("test defaults to a receipt and honours kind=kitchen", async () => {
    await POST(request({ op: "test", connection: CONNECTION }));
    expect(service.printTestJob).toHaveBeenCalledWith(CONNECTION, "receipt");
    await POST(request({ op: "test", connection: CONNECTION, kind: "kitchen" }));
    expect(service.printTestJob).toHaveBeenCalledWith(CONNECTION, "kitchen");
  });

  it("drawer-kick → kickDrawerJob", async () => {
    const response = await POST(request({ op: "drawer-kick", connection: CONNECTION }));
    expect(response.status).toBe(200);
    expect(service.kickDrawerJob).toHaveBeenCalledWith(CONNECTION);
  });
});

describe("printer failures", () => {
  it("maps a service throw to 502 with the error's own message", async () => {
    vi.mocked(service.printReceiptJob).mockRejectedValue(new Error("printer_timeout"));
    const response = await POST(request({ op: "receipt", connection: CONNECTION, receipt: {} }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ ok: false, error: "printer_timeout" });
  });

  it("falls back to printer_unreachable when the error has no message", async () => {
    vi.mocked(service.kickDrawerJob).mockRejectedValue(new Error(""));
    const response = await POST(request({ op: "drawer-kick", connection: CONNECTION }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "printer_unreachable" });
  });
});
