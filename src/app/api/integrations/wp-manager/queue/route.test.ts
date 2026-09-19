import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as connectionsService from "@/lib/integrations/connections-service";
import * as wpManagerService from "@/lib/integrations/wp-manager-service";
import { GET, POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/integrations/connections-service", () => ({
  getConnection: vi.fn(),
}));

vi.mock("@/lib/integrations/wp-manager-service", () => ({
  wpQueue: vi.fn(),
  wpQueueSummary: vi.fn(),
  retryWpQueueRow: vi.fn(),
  retryAllFailedWpQueue: vi.fn(),
  flushWpOutbox: vi.fn(),
}));

const SESSION = {
  businessId: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
  sub: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12",
  role: "owner",
};

const CONNECTION_ID = "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13";

const MOCK_CONNECTION = {
  id: CONNECTION_ID,
  business_id: SESSION.businessId,
  provider: "woocommerce",
  status: "active",
  link_mode: "plugin",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requireRole).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(connectionsService.getConnection).mockResolvedValue(MOCK_CONNECTION as never);
});

describe("GET /api/integrations/wp-manager/queue", () => {
  it("returns 400 when connectionId is missing", async () => {
    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "missing_connection" });
  });

  it("returns 404 when connection is not found or not woocommerce", async () => {
    vi.mocked(connectionsService.getConnection).mockResolvedValueOnce(null as never);
    const req = new Request(`http://localhost:3000/api/integrations/wp-manager/queue?connectionId=${CONNECTION_ID}`);
    const res = await GET(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "not_found" });
  });

  it("returns rows and summary for valid connection and passes filters", async () => {
    const mockRows = [
      {
        id: "job-1",
        direction: "out",
        kind: "stock",
        status: "pending",
        remoteId: "5001",
        error: null,
        attempts: 0,
        createdAt: "2026-09-18T10:00:00Z",
      },
    ];

    const mockSummary = {
      total: 1,
      pending: 1,
      processing: 0,
      failed: 0,
      dead: 0,
      sent: 0,
      inboundFailed: 0,
      outboundFailed: 0,
    };

    vi.mocked(wpManagerService.wpQueue).mockResolvedValueOnce(mockRows as never);
    vi.mocked(wpManagerService.wpQueueSummary).mockResolvedValueOnce(mockSummary as never);

    const req = new Request(
      `http://localhost:3000/api/integrations/wp-manager/queue?connectionId=${CONNECTION_ID}&status=pending&direction=out&search=5001`,
    );
    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.summary).toEqual(mockSummary);
    expect(wpManagerService.wpQueue).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, {
      status: "pending",
      direction: "out",
      search: "5001",
      limit: undefined,
    });
  });
});

describe("POST /api/integrations/wp-manager/queue", () => {
  it("returns 400 on invalid JSON body", async () => {
    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "invalid_json" });
  });

  it("retries a single queue row when action is retry", async () => {
    vi.mocked(wpManagerService.retryWpQueueRow).mockResolvedValueOnce({ ok: true, status: "pending" });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({
        action: "retry",
        connectionId: CONNECTION_ID,
        id: "row-123",
        direction: "out",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "pending" });
    expect(wpManagerService.retryWpQueueRow).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID, "row-123", "out");
  });

  it("retries all failed queue rows when action is retry_all", async () => {
    vi.mocked(wpManagerService.retryAllFailedWpQueue).mockResolvedValueOnce({
      ok: true,
      outboxRetried: 3,
      inboxRetried: 1,
    });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({
        action: "retry_all",
        connectionId: CONNECTION_ID,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, outboxRetried: 3, inboxRetried: 1 });
    expect(wpManagerService.retryAllFailedWpQueue).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID);
  });

  it("flushes outbox queue when action is flush", async () => {
    vi.mocked(wpManagerService.flushWpOutbox).mockResolvedValueOnce({
      ok: true,
      mode: "plugin",
      message: "در حالت افزونه، کارهای در انتظار در درخواست بعدی ارسال می‌شوند.",
    });

    const req = new Request("http://localhost:3000/api/integrations/wp-manager/queue", {
      method: "POST",
      body: JSON.stringify({
        action: "flush",
        connectionId: CONNECTION_ID,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("plugin");
    expect(wpManagerService.flushWpOutbox).toHaveBeenCalledWith(SESSION.businessId, CONNECTION_ID);
  });
});
