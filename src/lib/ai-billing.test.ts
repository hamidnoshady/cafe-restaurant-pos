import { describe, expect, it } from "vitest";
import {
  calculateAiUsageCostRial,
  creditUnitsForRial,
  estimateTokens,
} from "./ai-billing";

describe("calculateAiUsageCostRial", () => {
  it("charges actual input and output usage in one integer-Rial rounding", () => {
    expect(
      calculateAiUsageCostRial(
        { inputTokens: 250_000, outputTokens: 500_000 },
        { inputTokenRialPerMillion: 40_000, outputTokenRialPerMillion: 80_000 },
      ),
    ).toBe(50_000);
  });

  it("rounds a fractional Rial up once and ignores malformed negative values", () => {
    expect(
      calculateAiUsageCostRial(
        { inputTokens: 1, outputTokens: 1 },
        { inputTokenRialPerMillion: 1, outputTokenRialPerMillion: 1 },
      ),
    ).toBe(1);
    expect(
      calculateAiUsageCostRial(
        { inputTokens: -3, outputTokens: Number.NaN },
        { inputTokenRialPerMillion: 10, outputTokenRialPerMillion: 10 },
      ),
    ).toBe(0);
  });

  it("forces negative values to 0 using wholeNonNegative", () => {
    expect(
      calculateAiUsageCostRial(
        { inputTokens: -100, outputTokens: 500_000 },
        { inputTokenRialPerMillion: 40_000, outputTokenRialPerMillion: 80_000 },
      ),
    ).toBe(40_000);

    expect(
      calculateAiUsageCostRial(
        { inputTokens: 250_000, outputTokens: -500 },
        { inputTokenRialPerMillion: 40_000, outputTokenRialPerMillion: 80_000 },
      ),
    ).toBe(10_000);

    expect(
      calculateAiUsageCostRial(
        { inputTokens: 250_000, outputTokens: 500_000 },
        { inputTokenRialPerMillion: -40_000, outputTokenRialPerMillion: 80_000 },
      ),
    ).toBe(40_000);

    expect(
      calculateAiUsageCostRial(
        { inputTokens: 250_000, outputTokens: 500_000 },
        { inputTokenRialPerMillion: 40_000, outputTokenRialPerMillion: -80_000 },
      ),
    ).toBe(10_000);
  });
});

describe("estimateTokens", () => {
  it("uses a conservative character fallback when provider usage is absent", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("سلام")).toBe(2);
  });

  it("handles strings with only whitespace", () => {
    expect(estimateTokens("   ")).toBe(0);
    expect(estimateTokens("\t\n")).toBe(0);
  });

  it("trims surrounding whitespace before estimating", () => {
    expect(estimateTokens("  سلام  ")).toBe(2);
  });

  it("handles complex UTF-8 characters and emojis", () => {
    // Array.from("👨‍👩‍👧‍👦").length is 7, Math.ceil(7 / 2) = 4
    expect(estimateTokens("👨‍👩‍👧‍👦")).toBe(4);
    // Array.from("🚀").length is 1, Math.ceil(1 / 2) = 1
    expect(estimateTokens("🚀")).toBe(1);
    // Array.from("🚀 سلام").length is 6, Math.ceil(6 / 2) = 3
    expect(estimateTokens("🚀 سلام")).toBe(3);
  });

  it("handles very large strings", () => {
    const largeString = "a".repeat(10000);
    expect(estimateTokens(largeString)).toBe(5000);

    const largePersianString = "س".repeat(10001);
    expect(estimateTokens(largePersianString)).toBe(5001);
  });
});

describe("credit display helpers", () => {
  it("never renders a negative or undefined credit balance", () => {
    expect(creditUnitsForRial(25_000, 10_000)).toBe(2);
    expect(creditUnitsForRial(-1, 10_000)).toBe(0);
    expect(creditUnitsForRial(25_000, 0)).toBe(0);
  });

  it("returns 0 when unit cost is 0 to avoid division by zero", () => {
    expect(creditUnitsForRial(100, 0)).toBe(0);
  });
});
