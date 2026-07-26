import { describe, expect, it } from "vitest";
import { ageInvoices, bucketForAge, summarizeAging } from "./ar";

describe("bucketForAge", () => {
  it("buckets in 30-day steps, current through 90+", () => {
    expect(bucketForAge(0)).toBe("current");
    expect(bucketForAge(30)).toBe("current");
    expect(bucketForAge(31)).toBe("d31_60");
    expect(bucketForAge(60)).toBe("d31_60");
    expect(bucketForAge(61)).toBe("d61_90");
    expect(bucketForAge(90)).toBe("d61_90");
    expect(bucketForAge(91)).toBe("over90");
    expect(bucketForAge(400)).toBe("over90");
  });
});

describe("ageInvoices", () => {
  it("returns a fully-unpaid invoice untouched, aged from its own date", () => {
    const aged = ageInvoices([{ id: "i1", date: "2025-01-01", amount: 100_000 }], [], "2025-02-15");
    expect(aged).toHaveLength(1);
    expect(aged[0].outstanding).toBe(100_000);
    expect(aged[0].ageDays).toBe(45);
    expect(aged[0].bucket).toBe("d31_60");
  });

  it("drops an invoice fully paid off by receipts", () => {
    const aged = ageInvoices(
      [{ id: "i1", date: "2025-01-01", amount: 100_000 }],
      [{ id: "r1", date: "2025-01-10", amount: 100_000 }],
      "2025-02-01",
    );
    expect(aged).toHaveLength(0);
  });

  it("applies receipts FIFO across multiple invoices, oldest first", () => {
    const invoices = [
      { id: "i1", date: "2025-01-01", amount: 100_000 },
      { id: "i2", date: "2025-01-15", amount: 100_000 },
    ];
    const receipts = [{ id: "r1", date: "2025-01-20", amount: 150_000 }];
    const aged = ageInvoices(invoices, receipts, "2025-02-01");
    // i1 (oldest) fully paid; i2 partially paid, 50,000 left outstanding.
    expect(aged).toHaveLength(1);
    expect(aged[0].id).toBe("i2");
    expect(aged[0].outstanding).toBe(50_000);
  });

  it("leaves everything outstanding when there are no receipts", () => {
    const invoices = [
      { id: "i1", date: "2025-01-01", amount: 40_000 },
      { id: "i2", date: "2025-01-15", amount: 60_000 },
    ];
    const aged = ageInvoices(invoices, [], "2025-01-16");
    expect(aged.map((a) => a.outstanding)).toEqual([40_000, 60_000]);
  });

  it("ignores unapplied excess receipts beyond total invoiced", () => {
    const aged = ageInvoices(
      [{ id: "i1", date: "2025-01-01", amount: 50_000 }],
      [{ id: "r1", date: "2025-01-05", amount: 200_000 }],
      "2025-01-10",
    );
    expect(aged).toHaveLength(0);
  });
});

describe("summarizeAging", () => {
  it("sums outstanding amounts per bucket and overall", () => {
    const summary = summarizeAging([
      { id: "i1", date: "2025-01-01", amount: 10_000, outstanding: 10_000, ageDays: 5, bucket: "current" },
      { id: "i2", date: "2025-01-01", amount: 20_000, outstanding: 20_000, ageDays: 45, bucket: "d31_60" },
      { id: "i3", date: "2025-01-01", amount: 5_000, outstanding: 5_000, ageDays: 45, bucket: "d31_60" },
      { id: "i4", date: "2025-01-01", amount: 7_000, outstanding: 7_000, ageDays: 120, bucket: "over90" },
    ]);
    expect(summary).toEqual({ current: 10_000, d31_60: 25_000, d61_90: 0, over90: 7_000, total: 42_000 });
  });

  it("returns all zeros for no aged invoices", () => {
    expect(summarizeAging([])).toEqual({ current: 0, d31_60: 0, d61_90: 0, over90: 0, total: 0 });
  });
});
