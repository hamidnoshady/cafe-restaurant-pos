/**
 * Printer settings API regression coverage. Installed Windows queues carry no
 * IP address, and saving a default touches pre-existing JSON rows before the
 * insert; both paths must remain valid and transactional.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import * as setupState from "@/lib/setup-state";
import { GET, POST } from "./route";

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
  return { ...actual, getPool: vi.fn(), query: vi.fn() };
});

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, resolveActiveLocation: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "owner-1" };
const SAVED = {
  id: "printer-1",
  name: "EPSON TM-T20III",
  kind: "receipt",
  connection: { transport: "system", systemName: "EPSON TM-T20III" },
  is_active: true,
};

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

function mockClient() {
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => ({
      rows: sql.includes("INSERT INTO printers") ? [SAVED] : [],
    })),
    release: vi.fn(),
  };
}

let client: ReturnType<typeof mockClient>;

beforeEach(() => {
  vi.clearAllMocks();
  client = mockClient();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue({ id: "loc-1" } as never);
  vi.mocked(db.getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never);
  vi.mocked(db.query).mockResolvedValue({ rows: [SAVED], rowCount: 1 } as never);
});

describe("GET /api/settings/printers", () => {
  it("orders defaults with safe JSON containment rather than a fragile text-to-boolean cast", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ printers: [SAVED] });
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain("connection @>");
    expect(sql).not.toContain("connection->>'isDefault')::boolean");
  });

  it("returns a stable error body when the database read fails", async () => {
    vi.mocked(db.query).mockRejectedValue(new Error("invalid input syntax for type boolean"));
    const response = await GET();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "printer_list_failed", printers: [] });
  });
});

describe("POST /api/settings/printers", () => {
  it("saves an installed Windows USB queue without requiring an IP", async () => {
    const response = await POST(
      request({
        name: "EPSON TM-T20III",
        kind: "receipt",
        transport: "system",
        systemName: "EPSON TM-T20III",
        paper: "thermal80",
        paperWidthMm: 80,
        isActive: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ printer: SAVED });
    expect(client.query).toHaveBeenCalledWith("BEGIN");
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.query).not.toHaveBeenCalledWith("ROLLBACK");
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO printers"));
    expect(insert?.[1]?.[0]).toBe("loc-1");
    expect(JSON.parse(String(insert?.[1]?.[3]))).toMatchObject({
      transport: "system",
      systemName: "EPSON TM-T20III",
      ip: null,
    });
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("clears an old default defensively and atomically", async () => {
    const response = await POST(
      request({
        name: "POS80",
        kind: "receipt",
        transport: "system",
        systemName: "POS80",
        paperWidthMm: 80,
        isDefault: true,
      }),
    );
    expect(response.status).toBe(201);
    const update = client.query.mock.calls.find(([sql]) => String(sql).includes("UPDATE printers"));
    expect(update?.[0]).toContain("jsonb_typeof(connection)");
    expect(update?.[0]).toContain("||");
  });

  it("rolls back and returns printer_save_failed when the insert fails", async () => {
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO printers")) throw new Error("database down");
      return { rows: [] };
    });
    const response = await POST(
      request({ name: "POS80", kind: "receipt", transport: "system", systemName: "POS80", paperWidthMm: 80 }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "printer_save_failed" });
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns the permission error without touching the database", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    const response = await POST(request({}));
    expect(response).toBe(denied);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.settingsManage);
    expect(db.getPool).not.toHaveBeenCalled();
  });
});
