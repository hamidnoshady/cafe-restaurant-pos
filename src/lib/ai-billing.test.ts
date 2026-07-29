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
});

describe("credit display helpers", () => {
  it("uses a conservative character fallback when provider usage is absent", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("سلام")).toBe(2);
  });

  it("never renders a negative or undefined credit balance", () => {
    expect(creditUnitsForRial(25_000, 10_000)).toBe(2);
    expect(creditUnitsForRial(-1, 10_000)).toBe(0);
    expect(creditUnitsForRial(25_000, 0)).toBe(0);
  });
});
