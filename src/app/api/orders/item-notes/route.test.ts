import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import * as auth from "@/lib/auth";
import * as db from "@/lib/db";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: never[]) => unknown) => handler,
  };
});

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  return { ...actual, query: vi.fn() };
});

const ITEM_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({
    session: { businessId: "business-1" },
    error: null,
  } as never);
});

describe("GET /api/orders/item-notes", () => {
  it("scopes location-owned orders through locations.business_id", async () => {
    vi.mocked(db.query).mockResolvedValue({
      rows: [{ note: "بدون شکر" }, { note: "کم نمک" }],
    } as never);

    const response = await GET({ url: `http://pos.test/api/orders/item-notes?itemId=${ITEM_ID}` } as NextRequest);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notes: ["بدون شکر", "کم نمک"] });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("JOIN locations l ON l.id = oi.location_id"),
      ["business-1", ITEM_ID],
    );
    const sql = vi.mocked(db.query).mock.calls[0][0];
    expect(sql).toContain("l.business_id = $1");
    expect(sql).not.toContain("o.business_id");
  });

  it("rejects an invalid item id before querying", async () => {
    const response = await GET({ url: "http://pos.test/api/orders/item-notes?itemId=bad" } as NextRequest);
    expect(response.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});
