import { describe, expect, it } from "vitest";
import { rateQuantity, selectPriceVersion } from "./engine";

const v4 = {
  version: 4,
  effectiveFrom: "2026-09-01T00:00:00.000Z",
  effectiveUntil: "2027-01-01T00:00:00.000Z",
  unitAmountRial: 100,
  unitSize: 1,
};
const v5 = {
  version: 5,
  effectiveFrom: "2027-01-01T00:00:00.000Z",
  effectiveUntil: null,
  unitAmountRial: 200,
  unitSize: 1,
};

describe("rating", () => {
  it("selects the price version effective at the usage instant", () => {
    expect(selectPriceVersion([v5, v4], "2026-09-18T00:00:00.000Z")?.version).toBe(4);
    expect(selectPriceVersion([v5, v4], "2027-02-01T00:00:00.000Z")?.version).toBe(5);
  });

  it("consumes allowance before overage and refuses a missing price", () => {
    const rated = rateQuantity({
      quantity: 150,
      includedRemaining: 100,
      overageEnabled: true,
      hardLimit: null,
      price: { unitAmountRial: 10, unitSize: 1 },
      rounding: "ceil",
    });
    expect(rated.includedConsumed).toBe(100);
    expect(rated.overageQuantity).toBe(50);
    expect(rated.amountRial).toBe(500);
    expect(rated.blocked).toBe(false);

    const missing = rateQuantity({
      quantity: 10,
      includedRemaining: 0,
      overageEnabled: true,
      hardLimit: null,
      price: null,
      rounding: "ceil",
    });
    expect(missing.blocked).toBe(true);
    expect(missing.blockReason).toBe("no_price");
    expect(missing.amountRial).toBe(0);
  });
});
