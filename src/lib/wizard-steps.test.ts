import { describe, expect, it } from "vitest";
import { OPTIONAL_STEPS, WIZARD_STEPS, wizardStepsForIndustry } from "./wizard-steps";
import { INDUSTRIES } from "./industries";

describe("wizardStepsForIndustry", () => {
  it("walks every step for food_service", () => {
    expect(wizardStepsForIndustry("food_service")).toEqual([...WIZARD_STEPS]);
  });

  it("skips costing and menu for jewelry -- neither table exists in its data model", () => {
    const steps = wizardStepsForIndustry("jewelry");
    expect(steps).not.toContain("costing");
    expect(steps).not.toContain("menu");
    expect(steps).toEqual(["business", "accounts", "tax", "users", "hardware", "backup", "opening"]);
  });

  it("keeps every other step, in the same relative order, for jewelry", () => {
    const steps = wizardStepsForIndustry("jewelry");
    const fullMinusFoodServiceOnly = WIZARD_STEPS.filter((s) => s !== "costing" && s !== "menu");
    expect(steps).toEqual(fullMinusFoodServiceOnly);
  });

  it("gives every enabled/reserved industry a non-empty, in-order subsequence of WIZARD_STEPS", () => {
    for (const industry of INDUSTRIES) {
      const steps = wizardStepsForIndustry(industry);
      expect(steps.length).toBeGreaterThan(0);
      const indices = steps.map((s) => WIZARD_STEPS.indexOf(s));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    }
  });

  it("never drops an optional step", () => {
    for (const industry of INDUSTRIES) {
      const steps = new Set(wizardStepsForIndustry(industry));
      for (const optional of OPTIONAL_STEPS) {
        expect(steps.has(optional)).toBe(true);
      }
    }
  });
});
