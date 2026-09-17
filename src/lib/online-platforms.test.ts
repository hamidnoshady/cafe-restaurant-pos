import { describe, expect, it } from "vitest";
import { validCommissionPercent } from "./online-platforms";
import { commissionAmountFor } from "./online-platforms-calculation";
import type { RialText } from "./inventory-exact";

describe("online platform commission", () => {
  it("accepts the full 0–100 percent contract range", () => {
    expect(validCommissionPercent(0)).toBe(true);
    expect(validCommissionPercent(100)).toBe(true);
    expect(validCommissionPercent(-0.01)).toBe(false);
    expect(validCommissionPercent(100.01)).toBe(false);
    expect(validCommissionPercent("20")).toBe(false);
    expect(validCommissionPercent(true)).toBe(false);
  });

  it("rounds whole-Rial commission with decimal arithmetic", () => {
    expect(commissionAmountFor("100000" as RialText, 22.5)).toBe("22500");
    expect(commissionAmountFor("1" as RialText, 50)).toBe("1");
    expect(commissionAmountFor("9007199254740993" as RialText, 20)).toBe("1801439850948199");
  });
});
