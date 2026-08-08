import { describe, expect, it } from "vitest";
import { INDUSTRIES, isIndustry } from "./industries";

describe("isIndustry", () => {
  it("returns true for all defined valid industries", () => {
    INDUSTRIES.forEach((industry) => {
      expect(isIndustry(industry)).toBe(true);
    });
  });

  it("returns false for invalid industry strings", () => {
    const invalidInputs = [
      "",
      "food-service", // hyphen instead of underscore
      "FOOD_SERVICE", // uppercase
      "unknown_industry",
      "café",
    ];

    invalidInputs.forEach((invalidInput) => {
      expect(isIndustry(invalidInput)).toBe(false);
    });
  });

  it("handles empty and unrelated inputs safely", () => {
    // Technically typing of isIndustry expects a string, but if called from JS or any without strict checking
    expect(isIndustry("")).toBe(false);
    expect(isIndustry("    ")).toBe(false);
  });
});
