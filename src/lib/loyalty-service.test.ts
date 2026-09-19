import { beforeEach, describe, expect, it, vi } from "vitest";
import { pointsBalance, upsertProgram } from "./loyalty-service";
import * as db from "./db";

vi.mock("./db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));

const BUSINESS = "00000000-0000-4000-8000-000000000001";
const CUSTOMER = "00000000-0000-4000-8000-000000000002";

const programRow = {
  id: "00000000-0000-4000-8000-000000000003",
  business_id: BUSINESS,
  name: "برنامه",
  earn_points_per_100000: 3,
  point_value_rial: 1000,
  points_expiry_days: null,
  is_active: true,
  is_default: true,
};

function programClient() {
  const client = {
    query: vi.fn(async (sql: string, ..._params: unknown[]) => {
      if (sql.includes("SELECT * FROM loyalty_programs") && sql.includes("FOR UPDATE")) {
        return { rows: [programRow] };
      }
      if (sql.includes("INSERT INTO loyalty_programs")) return { rows: [programRow] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  vi.mocked(db.getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never);
  return client;
}

describe("pointsBalance", () => {
  beforeEach(() => {
    vi.mocked(db.query).mockReset();
    vi.mocked(db.getPool).mockReset();
  });

  it("uses the requested business date and keeps point lots spendable through their expiry date", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [{ balance: "70" }] } as never);

    expect(await pointsBalance(BUSINESS, CUSTOMER, undefined, "2026-01-02")).toBe(70);
    expect(vi.mocked(db.query)).toHaveBeenCalledWith(
      expect.stringContaining("expires_at IS NULL OR expires_at >= $3::date"),
      [BUSINESS, CUSTOMER, "2026-01-02"],
    );
  });

  it("rejects invalid as-of dates before issuing a database query", async () => {
    await expect(pointsBalance(BUSINESS, CUSTOMER, undefined, "not-a-date")).rejects.toThrow("تاریخ محاسبهٔ امتیاز");
    expect(vi.mocked(db.query)).not.toHaveBeenCalled();
  });
});

describe("upsertProgram validation and partial edits", () => {
  it("rejects fractional values rather than relying on a database cast", async () => {
    await expect(upsertProgram(BUSINESS, { name: "برنامه", earnPointsPer100000: 1.5 })).rejects.toThrow(
      "نرخ کسب امتیاز",
    );
    await expect(upsertProgram(BUSINESS, { name: "برنامه", pointValueRial: 999.5 })).rejects.toThrow(
      "ارزش ریالی هر امتیاز",
    );
  });

  it("accepts a zero earn rate, preserving the stored fields omitted by a partial edit", async () => {
    const client = programClient();

    const saved = await upsertProgram(BUSINESS, { name: "برنامه", earnPointsPer100000: 0 });

    expect(saved).toMatchObject({ id: programRow.id, earnPointsPer100000: 3, isDefault: true });
    const insertCall = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO loyalty_programs"));
    expect(insertCall).toBeDefined();
    // business, name, rate, value, expiry, active, chosen default
    expect(insertCall?.[1]).toEqual([BUSINESS, "برنامه", 0, 1000, null, true, true]);
  });

  it("rejects an inactive default program before opening a transaction", async () => {
    await expect(upsertProgram(BUSINESS, { name: "برنامه", isActive: false, isDefault: true })).rejects.toThrow(
      "پیش‌فرض باید فعال باشد",
    );
  });
});
