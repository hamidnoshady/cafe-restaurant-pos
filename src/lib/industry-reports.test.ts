import { describe, expect, it } from "vitest";
import { consignorBalance, repairProfit, warrantyState, weightVariance } from "./industry-reports";

describe("weightVariance", () => {
  it("is counted − system, with a percentage of the system figure", () => {
    expect(weightVariance("99.5", "100")).toEqual({
      countedWeight: "99.5",
      systemWeight: "100",
      variance: "-0.5",
      variancePercent: 0.5,
    });
  });

  it("reports a surplus as a positive variance", () => {
    expect(weightVariance("101.25", "100").variance).toBe("1.25");
  });

  it("is exact at three decimal places of a gram — no floating-point drift", () => {
    expect(weightVariance("12.345", "12.344").variance).toBe("0.001");
  });

  it("has no percentage when the system believed there was nothing to count", () => {
    expect(weightVariance("3", "0").variancePercent).toBeNull();
  });
});

describe("warrantyState", () => {
  const warranty = { startDate: "2026-01-01", endDate: "2027-01-01" };

  it("is none for a unit with no warranty at all", () => {
    expect(warrantyState(null, "2026-06-01")).toBe("none");
  });

  it("is active well inside the window and expired past its end", () => {
    expect(warrantyState(warranty, "2026-06-01")).toBe("active");
    expect(warrantyState(warranty, "2027-01-02")).toBe("expired");
  });

  it("is expiring within the notice window, and on the last day itself", () => {
    expect(warrantyState(warranty, "2026-12-15")).toBe("expiring");
    expect(warrantyState(warranty, "2027-01-01")).toBe("expiring");
  });

  it("takes the notice window as a parameter", () => {
    expect(warrantyState(warranty, "2026-11-15", 30)).toBe("active");
    expect(warrantyState(warranty, "2026-11-15", 90)).toBe("expiring");
  });
});

describe("repairProfit", () => {
  it("totals revenue and parts cost across tickets", () => {
    expect(repairProfit([
      { net: 2_800_000, partsCost: 300_000 },
      { net: 1_000_000, partsCost: 100_000 },
    ])).toEqual({ revenue: 3_800_000, partsCost: 400_000, margin: 3_400_000 });
  });

  it("reports a negative margin for a warranty job rather than hiding it", () => {
    expect(repairProfit([{ net: 0, partsCost: 1_500_000 }]).margin).toBe(-1_500_000);
  });

  it("is all zeroes for no tickets", () => {
    expect(repairProfit([])).toEqual({ revenue: 0, partsCost: 0, margin: 0 });
  });
});

describe("consignorBalance", () => {
  it("is what their sold goods credited, less what has been paid out", () => {
    expect(consignorBalance({ owed: 50_000_000, paid: 20_000_000 })).toBe(30_000_000);
    expect(consignorBalance({ owed: 50_000_000, paid: 50_000_000 })).toBe(0);
  });
});
