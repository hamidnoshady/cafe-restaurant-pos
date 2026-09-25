import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as service from "@/lib/integrations/connections-service";
import { PATCH } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/integrations/connections-service", () => ({
  updateConnection: vi.fn(),
  deleteConnection: vi.fn(),
}));

const session = { businessId: "biz-1", sub: "user-1", role: "owner" };
const params = { params: Promise.resolve({ id: "conn-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session, error: null } as never);
  vi.mocked(service.updateConnection).mockResolvedValue({ ok: true, connection: { id: "conn-1" } } as never);
});

describe("PATCH /api/integrations/connections/[id]", () => {
  it("forwards every sync setting supported by updateConnection", async () => {
    const body = {
      syncOrders: false,
      syncProducts: true,
      syncCustomers: false,
      pushStock: true,
      pushPrices: false,
      syncCategories: true,
      autoPullOrders: false,
      orderLookbackDays: 30,
    };

    const res = await PATCH(
      new Request("http://localhost/api/integrations/connections/conn-1", {
        method: "PATCH",
        body: JSON.stringify(body),
      }) as never,
      params as never,
    );

    expect(res.status).toBe(200);
    expect(service.updateConnection).toHaveBeenCalledWith(session.businessId, "conn-1", expect.objectContaining(body));
  });
});
