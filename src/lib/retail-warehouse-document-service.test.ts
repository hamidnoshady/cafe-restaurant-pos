import { describe, expect, it } from "vitest";
import {
  eventTypeForRetailWarehouseDocument,
  generatedLotNumber,
  isRetailWarehouseDocumentKind,
  lotCoversQuantity,
  nextLotUnitCost,
  parseRetailWarehouseDocumentLines,
  preservedExpiry,
  retailLineValue,
} from "./retail-warehouse-document-service";

describe("isRetailWarehouseDocumentKind", () => {
  it("accepts the two kinds and nothing else", () => {
    expect(isRetailWarehouseDocumentKind("receipt")).toBe(true);
    expect(isRetailWarehouseDocumentKind("issue")).toBe(true);
    expect(isRetailWarehouseDocumentKind("transfer")).toBe(false);
    expect(isRetailWarehouseDocumentKind("")).toBe(false);
    expect(isRetailWarehouseDocumentKind(null)).toBe(false);
    expect(isRetailWarehouseDocumentKind(42)).toBe(false);
  });
});

describe("kind → event mapping", () => {
  it("maps kinds to their domain events", () => {
    expect(eventTypeForRetailWarehouseDocument("receipt")).toBe("retail.warehouse_receipt");
    expect(eventTypeForRetailWarehouseDocument("issue")).toBe("retail.warehouse_issue");
  });
});

describe("parseRetailWarehouseDocumentLines", () => {
  it("parses a receipt with costs, lots, expiries and a total", () => {
    const parsed = parseRetailWarehouseDocumentLines("receipt", [
      { itemId: "a", quantity: "2", unitCost: 2500, lot: "L-1", expiryDate: "2026-12-01" },
      { itemId: "b", quantity: "1.5", unitCost: 1000 },
    ]);
    expect(parsed.kind).toBe("receipt");
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].unitCost).toBe(2500);
    expect(parsed.lines[0].lotNumber).toBe("L-1");
    expect(parsed.lines[0].expiryDate).toBe("2026-12-01");
    expect(parsed.lines[0].value).toBe("5000");
    expect(parsed.lines[1].lotNumber).toBeNull();
    expect(parsed.lines[1].expiryDate).toBeNull();
    expect(parsed.lines[1].value).toBe("1500");
    expect(parsed.totalValue).toBe("6500");
  });

  it("parses an issue with zero cost and value regardless of what was sent", () => {
    const parsed = parseRetailWarehouseDocumentLines("issue", [
      { itemId: "a", quantity: "3", unitCost: 999999, lot: "L-1" },
    ]);
    expect(parsed.kind).toBe("issue");
    expect(parsed.lines[0].unitCost).toBe(0);
    expect(parsed.lines[0].value).toBe("0");
    expect(parsed.totalValue).toBe("0");
  });

  it("refuses a receipt line without a unit cost", () => {
    expect(() => parseRetailWarehouseDocumentLines("receipt", [{ itemId: "a", quantity: "1" }])).toThrow(
      "missing_cost",
    );
    expect(() =>
      parseRetailWarehouseDocumentLines("receipt", [{ itemId: "a", quantity: "1", unitCost: "" }]),
    ).toThrow("missing_cost");
  });

  it("refuses a receipt line whose cost is not a whole-Rial number", () => {
    expect(() =>
      parseRetailWarehouseDocumentLines("receipt", [{ itemId: "a", quantity: "1", unitCost: 10.5 }]),
    ).toThrow("invalid_cost");
  });

  it("refuses a negative receipt cost", () => {
    expect(() =>
      parseRetailWarehouseDocumentLines("receipt", [{ itemId: "a", quantity: "1", unitCost: -5 }]),
    ).toThrow("invalid_cost");
  });

  it("refuses an empty document", () => {
    expect(() => parseRetailWarehouseDocumentLines("receipt", [])).toThrow("no_items");
  });

  it("refuses a line without an item", () => {
    expect(() => parseRetailWarehouseDocumentLines("receipt", [{ quantity: "1", unitCost: 100 }])).toThrow(
      "invalid_line",
    );
  });

  it("refuses the same item twice in one document", () => {
    expect(() =>
      parseRetailWarehouseDocumentLines("receipt", [
        { itemId: "a", quantity: "1", unitCost: 100 },
        { itemId: "a", quantity: "2", unitCost: 100 },
      ]),
    ).toThrow("invalid_line");
  });

  it("refuses zero, negative and non-numeric quantities", () => {
    expect(() =>
      parseRetailWarehouseDocumentLines("receipt", [{ itemId: "a", quantity: "0", unitCost: 100 }]),
    ).toThrow("invalid_quantity");
    expect(() =>
      parseRetailWarehouseDocumentLines("issue", [{ itemId: "a", quantity: "-1", lot: "L" }]),
    ).toThrow("invalid_quantity");
    expect(() =>
      parseRetailWarehouseDocumentLines("receipt", [{ itemId: "a", quantity: "abc", unitCost: 100 }]),
    ).toThrow("invalid_quantity");
  });

  it("trims a blank lot to null and keeps a stated expiry", () => {
    const parsed = parseRetailWarehouseDocumentLines("receipt", [
      { itemId: "a", quantity: "1", unitCost: 100, lot: "   ", expiryDate: " 2027-01-31 " },
    ]);
    expect(parsed.lines[0].lotNumber).toBeNull();
    expect(parsed.lines[0].expiryDate).toBe("2027-01-31");
  });

  it("canonicalises a trailing-zero quantity", () => {
    const parsed = parseRetailWarehouseDocumentLines("issue", [{ itemId: "a", quantity: "2.50", lot: "L" }]);
    expect(parsed.lines[0].quantity).toBe("2.5");
  });

  it("refuses a unit cost past what a bigint Rial column holds", () => {
    // Reaching the INSERT with this aborted the transaction with «out of range
    // for type bigint» — a 500 for a mistyped cost.
    expect(() =>
      parseRetailWarehouseDocumentLines("receipt", [{ itemId: "a", quantity: "1", unitCost: 1e20 }]),
    ).toThrow("cost_out_of_range");
  });

  it("refuses a total past the ceiling even when every line fits", () => {
    const nearMax = Number.MAX_SAFE_INTEGER;
    expect(() =>
      parseRetailWarehouseDocumentLines("receipt", [
        { itemId: "a", quantity: "1000", unitCost: nearMax },
        { itemId: "b", quantity: "1000", unitCost: nearMax },
      ]),
    ).toThrow("cost_out_of_range");
  });
});

describe("retailLineValue", () => {
  it("multiplies quantity by unit cost in whole Rial", () => {
    expect(retailLineValue("2", 2500)).toBe("5000");
  });

  it("handles fractional quantities", () => {
    // 1.5 × 1000 = 1500.
    expect(retailLineValue("1.5", 1000)).toBe("1500");
  });

  it("rounds to the nearest whole Rial (half up)", () => {
    // 0.1 × 333 = 33.3 → 33; 0.1 × 5005 = 500.5 → 501.
    expect(retailLineValue("0.1", 333)).toBe("33");
    expect(retailLineValue("0.1", 5005)).toBe("501");
  });
});

describe("nextLotUnitCost", () => {
  it("re-averages an existing lot to the weighted average", () => {
    // 10 @ 100 topped up with 5 @ 130 → 1650 / 15 = 110.
    expect(nextLotUnitCost("10", 100, "5", 130)).toBe(110);
  });

  it("treats a null existing lot cost as unknown stock carried at zero value", () => {
    // The same treatment averageAcrossBatches gives a null-cost batch:
    // counted in quantity, worth nothing — 10@null + 5@100 → 500 / 15 ≈ 33.
    expect(nextLotUnitCost("10", null, "5", 100)).toBe(33);
  });

  it("rounds the average to whole Rial, half up", () => {
    // 3 @ 100 topped up with 3 @ 101 → 603 / 6 = 100.5 → 101.
    expect(nextLotUnitCost("3", 100, "3", 101)).toBe(101);
  });

  it("handles fractional quantities in the average", () => {
    // 0.5 @ 1000 + 0.5 @ 1002 → 1001.
    expect(nextLotUnitCost("0.5", 1000, "0.5", 1002)).toBe(1001);
  });
});

describe("preservedExpiry", () => {
  it("keeps the existing expiry unless the line supplies one (COALESCE)", () => {
    expect(preservedExpiry("2026-12-01", "2027-01-31")).toBe("2027-01-31");
    expect(preservedExpiry("2026-12-01", null)).toBe("2026-12-01");
    expect(preservedExpiry(null, "2027-01-31")).toBe("2027-01-31");
    expect(preservedExpiry(null, null)).toBeNull();
  });
});

describe("lotCoversQuantity", () => {
  it("covers an equal or smaller line, refuses a larger one", () => {
    expect(lotCoversQuantity("5", "5")).toBe(true);
    expect(lotCoversQuantity("5", "2")).toBe(true);
    expect(lotCoversQuantity("5", "5.0001")).toBe(false);
    expect(lotCoversQuantity("0", "1")).toBe(false);
  });
});

describe("generatedLotNumber", () => {
  it("names an unnamed receipt lot after its document and line", () => {
    expect(generatedLotNumber("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d", 2)).toBe("W-9b1deb4d-3");
  });
});
