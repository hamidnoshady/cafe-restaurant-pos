import { describe, expect, it } from "vitest";
import {
  addMonthsToIsoDate,
  isWarrantyActive,
  serviceDueDate,
  validateRepairPart,
  validateRepairStatusTransition,
  validateSerialUnitCost,
  validateServiceIntervalMonths,
  validateWarrantyMonths,
} from "./watch";

describe("validateSerialUnitCost", () => {
  it("accepts a whole positive Rial amount, and an absent one", () => {
    expect(validateSerialUnitCost(12_000_000)).toBeNull();
    expect(validateSerialUnitCost(null)).toBeNull();
    expect(validateSerialUnitCost(undefined)).toBeNull();
  });

  it("rejects zero, negative, and fractional costs", () => {
    expect(validateSerialUnitCost(0)).not.toBeNull();
    expect(validateSerialUnitCost(-1)).not.toBeNull();
    expect(validateSerialUnitCost(1.5)).not.toBeNull();
  });
});

describe("validateWarrantyMonths", () => {
  it("accepts zero — a unit sold with no warranty is a real answer, not a missing one", () => {
    expect(validateWarrantyMonths(0)).toBeNull();
    expect(validateWarrantyMonths(24)).toBeNull();
  });

  it("rejects negative, fractional, and absurd terms", () => {
    expect(validateWarrantyMonths(-1)).not.toBeNull();
    expect(validateWarrantyMonths(1.5)).not.toBeNull();
    expect(validateWarrantyMonths(1000)).not.toBeNull();
  });
});

describe("addMonthsToIsoDate", () => {
  it("adds whole months within a year", () => {
    expect(addMonthsToIsoDate("2026-01-15", 6)).toBe("2026-07-15");
  });

  it("rolls over the year boundary", () => {
    expect(addMonthsToIsoDate("2026-08-12", 24)).toBe("2028-08-12");
    expect(addMonthsToIsoDate("2026-11-30", 2)).toBe("2027-01-30");
  });

  it("clamps to the last day of a shorter target month rather than spilling into the next one", () => {
    expect(addMonthsToIsoDate("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToIsoDate("2028-01-31", 1)).toBe("2028-02-29"); // leap year
    expect(addMonthsToIsoDate("2026-03-31", 1)).toBe("2026-04-30");
  });

  it("treats zero months as the same day", () => {
    expect(addMonthsToIsoDate("2026-08-12", 0)).toBe("2026-08-12");
  });

  it("rejects a malformed date", () => {
    expect(() => addMonthsToIsoDate("12/08/2026", 1)).toThrow();
  });
});

describe("isWarrantyActive", () => {
  const warranty = { startDate: "2026-01-01", endDate: "2027-01-01" };

  it("covers both ends of the window inclusively", () => {
    expect(isWarrantyActive(warranty, "2026-01-01")).toBe(true);
    expect(isWarrantyActive(warranty, "2027-01-01")).toBe(true);
    expect(isWarrantyActive(warranty, "2026-06-15")).toBe(true);
  });

  it("is false outside the window, and for a unit with no warranty at all", () => {
    expect(isWarrantyActive(warranty, "2025-12-31")).toBe(false);
    expect(isWarrantyActive(warranty, "2027-01-02")).toBe(false);
    expect(isWarrantyActive(null, "2026-06-15")).toBe(false);
  });
});

describe("validateRepairStatusTransition", () => {
  it("walks forward through the workflow", () => {
    expect(validateRepairStatusTransition("received", "in_progress")).toBeNull();
    expect(validateRepairStatusTransition("in_progress", "ready")).toBeNull();
    expect(validateRepairStatusTransition("received", "ready")).toBeNull();
  });

  it("allows a no-op transition to the same status", () => {
    expect(validateRepairStatusTransition("in_progress", "in_progress")).toBeNull();
  });

  it("allows cancelling any open ticket", () => {
    expect(validateRepairStatusTransition("received", "cancelled")).toBeNull();
    expect(validateRepairStatusTransition("ready", "cancelled")).toBeNull();
  });

  it("refuses to move backwards", () => {
    expect(validateRepairStatusTransition("ready", "in_progress")).not.toBeNull();
    expect(validateRepairStatusTransition("in_progress", "received")).not.toBeNull();
  });

  it("treats closed and cancelled as terminal", () => {
    expect(validateRepairStatusTransition("closed", "in_progress")).not.toBeNull();
    expect(validateRepairStatusTransition("cancelled", "received")).not.toBeNull();
  });

  it("refuses to close through a bare status change — closing posts to the ledger", () => {
    expect(validateRepairStatusTransition("ready", "closed")).not.toBeNull();
  });
});

describe("validateRepairPart", () => {
  const valid = { description: "شیشه", quantity: "1", unitCost: 500_000, charge: 800_000 };

  it("accepts a well-formed part", () => {
    expect(validateRepairPart(valid)).toEqual([]);
  });

  it("accepts a zero charge — a warranty repair consumes parts it bills nobody for", () => {
    expect(validateRepairPart({ ...valid, charge: 0 })).toEqual([]);
  });

  it("rejects an empty description, a non-positive quantity, and fractional money", () => {
    expect(validateRepairPart({ ...valid, description: "  " }).length).toBe(1);
    expect(validateRepairPart({ ...valid, quantity: "0" }).length).toBe(1);
    expect(validateRepairPart({ ...valid, unitCost: -1 }).length).toBe(1);
    expect(validateRepairPart({ ...valid, charge: 1.5 }).length).toBe(1);
  });
});

describe("serviceDueDate", () => {
  it("is the sale date plus the model's service interval", () => {
    expect(serviceDueDate("2024-09-01", 24)).toBe("2026-09-01");
  });

  it("is null when there is no sale date or no interval — no reminder", () => {
    expect(serviceDueDate(null, 24)).toBeNull();
    expect(serviceDueDate("2024-09-01", null)).toBeNull();
    expect(serviceDueDate("2024-09-01", 0)).toBeNull();
  });
});

describe("validateServiceIntervalMonths", () => {
  it("accepts a sensible interval and an absent one", () => {
    expect(validateServiceIntervalMonths(24)).toBeNull();
    expect(validateServiceIntervalMonths(null)).toBeNull();
    expect(validateServiceIntervalMonths(undefined)).toBeNull();
  });

  it("rejects zero, negative, fractional, and absurd intervals", () => {
    expect(validateServiceIntervalMonths(0)).not.toBeNull();
    expect(validateServiceIntervalMonths(-1)).not.toBeNull();
    expect(validateServiceIntervalMonths(1.5)).not.toBeNull();
    expect(validateServiceIntervalMonths(200)).not.toBeNull();
  });
});
