import { describe, it, expect, vi, beforeEach } from "vitest";
import { pointsBalance, upsertProgram } from "./loyalty-service";
import * as db from "./db";

vi.mock("./db", () => ({
  query: vi.fn(),
  getPool: vi.fn(),
}));

// The posting-rules side-effect import pulls the whole engine in; none of it
// runs in these tests, but its imports must resolve, which they do.

const BUSINESS = "00000000-0000-4000-8000-000000000001";
const CUSTOMER = "00000000-0000-4000-8000-000000000002";

function mockLedger(rows: { points: number; expires_at: string | null; created_on: string }[]) {
  vi.mocked(db.query).mockResolvedValue({ rows } as never);
}

describe("pointsBalance", () => {
  beforeEach(() => {
    vi.mocked(db.query).mockReset();
  });

  it("sums a ledger with no expiry like the plain SUM it used to be", async () => {
    mockLedger([
      { points: 100, expires_at: null, created_on: "2026-01-01" },
      { points: -30, expires_at: null, created_on: "2026-02-01" },
    ]);
    expect(await pointsBalance(BUSINESS, CUSTOMER)).toBe(70);
  });

  it("forfeits an expired lot that was never redeemed", async () => {
    mockLedger([
      { points: 100, expires_at: null, created_on: "2026-01-01" },
      // Advertised as expiring and long past: must not count.
      { points: 50, expires_at: "2020-01-01", created_on: "2019-12-01" },
    ]);
    expect(await pointsBalance(BUSINESS, CUSTOMER)).toBe(100);
  });

  it("does not resurrect points that were redeemed before their lot expired", async () => {
    mockLedger([
      // 100 expiring points; 80 were spent in time, so only 20 lapse.
      { points: 100, expires_at: "2020-06-01", created_on: "2020-01-01" },
      { points: -80, expires_at: null, created_on: "2020-03-01" },
    ]);
    expect(await pointsBalance(BUSINESS, CUSTOMER)).toBe(0);
  });

  it("spends soonest-expiring lots first so redemption forfeits the least", async () => {
    mockLedger([
      { points: 50, expires_at: "2020-06-01", created_on: "2020-01-01" }, // lapsed
      { points: 50, expires_at: null, created_on: "2020-01-02" },
      // Spent while the expiring lot was valid → drawn from it, not the open one.
      { points: -40, expires_at: null, created_on: "2020-02-01" },
    ]);
    // 10 of the expiring lot lapse; the open 50 remain.
    expect(await pointsBalance(BUSINESS, CUSTOMER)).toBe(50);
  });

  it("never goes negative through expiry alone", async () => {
    mockLedger([
      { points: 30, expires_at: "2020-01-01", created_on: "2019-01-01" },
      { points: -30, expires_at: null, created_on: "2019-06-01" },
    ]);
    expect(await pointsBalance(BUSINESS, CUSTOMER)).toBe(0);
  });

  it("treats a redemption on the expiry day itself as valid", async () => {
    mockLedger([
      { points: 30, expires_at: "2020-01-01", created_on: "2019-01-01" },
      { points: -30, expires_at: null, created_on: "2020-01-01" },
    ]);
    expect(await pointsBalance(BUSINESS, CUSTOMER)).toBe(0);
  });
});

describe("upsertProgram validation", () => {
  it("rejects a fractional earn rate with a Persian message, not a DB error", async () => {
    await expect(
      upsertProgram(BUSINESS, { name: "برنامه", earnPointsPer100000: 1.5 }),
    ).rejects.toThrow("نرخ کسب امتیاز باید یک عدد صحیح صفر یا بیشتر باشد.");
  });

  it("rejects a fractional point value", async () => {
    await expect(
      upsertProgram(BUSINESS, { name: "برنامه", pointValueRial: 999.5 }),
    ).rejects.toThrow("ارزش ریالی هر امتیاز باید یک عدد صحیح مثبت باشد.");
  });

  it("rejects a zero or negative point value", async () => {
    await expect(upsertProgram(BUSINESS, { name: "برنامه", pointValueRial: 0 })).rejects.toThrow();
    await expect(upsertProgram(BUSINESS, { name: "برنامه", pointValueRial: -100 })).rejects.toThrow();
  });

  it("rejects a negative earn rate but accepts zero (a business may pause earning)", async () => {
    await expect(upsertProgram(BUSINESS, { name: "برنامه", earnPointsPer100000: -1 })).rejects.toThrow();

    // Zero passes validation and reaches the database layer.
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "p1",
            business_id: BUSINESS,
            name: "برنامه",
            earn_points_per_100000: 0,
            point_value_rial: 1000,
            points_expiry_days: null,
            is_active: true,
            is_default: false,
          },
        ],
      }),
      release: vi.fn(),
    };
    vi.mocked(db.getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never);
    const program = await upsertProgram(BUSINESS, { name: "برنامه", earnPointsPer100000: 0 });
    expect(program.earnPointsPer100000).toBe(0);
  });

  it("keeps a stored field when the caller does not send it (no silent default demotion)", async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            id: "p1",
            business_id: BUSINESS,
            name: "برنامه",
            earn_points_per_100000: 3,
            point_value_rial: 1000,
            points_expiry_days: null,
            is_active: true,
            is_default: true,
          },
        ],
      }),
      release: vi.fn(),
    };
    vi.mocked(db.getPool).mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never);

    await upsertProgram(BUSINESS, { name: "برنامه", earnPointsPer100000: 3 });

    // Since isDefault was not sent, no blanket demotion may run, and the
    // upsert must carry null (→ COALESCE keeps the stored value) not `false`.
    const calls = client.query.mock.calls.map((c) => String(c[0]));
    expect(calls.some((sql) => sql.includes("SET is_default = false WHERE"))).toBe(false);
    const insertCall = client.query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO loyalty_programs"));
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    // Params: business, name, earn, value, expiryProvided, expiry, isActive, isDefault
    expect(params[7]).toBeNull();
    expect(params[6]).toBeNull();
    expect(params[4]).toBe(false);
  });
});
