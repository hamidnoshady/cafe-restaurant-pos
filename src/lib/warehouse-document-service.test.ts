import { describe, expect, it } from "vitest";
import { quantityText, rialText } from "./inventory-exact";
import {
  eventTypeFor,
  isWarehouseDocumentKind,
  lineValue,
  movementTypeFor,
  parseWarehouseDocumentLines,
} from "./warehouse-document-service";

describe("isWarehouseDocumentKind", () => {
  it("accepts the two kinds and nothing else", () => {
    expect(isWarehouseDocumentKind("receipt")).toBe(true);
    expect(isWarehouseDocumentKind("issue")).toBe(true);
    expect(isWarehouseDocumentKind("transfer")).toBe(false);
    expect(isWarehouseDocumentKind("")).toBe(false);
    expect(isWarehouseDocumentKind(null)).toBe(false);
  });
});

describe("lineValue", () => {
  it("multiplies quantity by unit cost in whole Rial", () => {
    expect(lineValue(quantityText("2"), rialText("2500"))).toBe("5000");
  });

  it("handles fractional quantities", () => {
    // 1.5 kg × 2500 Rial/kg = 3750 Rial.
    expect(lineValue(quantityText("1.5"), rialText("2500"))).toBe("3750");
  });

  it("rounds to the nearest whole Rial (half up)", () => {
    // 0.1 × 333 = 33.3 → 33; 0.1 × 5005 = 500.5 → 501.
    expect(lineValue(quantityText("0.1"), rialText("333"))).toBe("33");
    expect(lineValue(quantityText("0.1"), rialText("5005"))).toBe("501");
  });
});

describe("parseWarehouseDocumentLines", () => {
  it("parses a receipt with values and a total", () => {
    const parsed = parseWarehouseDocumentLines("receipt", [
      { inventoryItemId: "a", quantity: "2", unitCost: "2500" },
      { inventoryItemId: "b", quantity: "1.5", unitCost: "1000" },
    ]);
    expect(parsed.kind).toBe("receipt");
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].value).toBe("5000");
    expect(parsed.lines[1].value).toBe("1500");
    expect(parsed.totalValue).toBe("6500");
  });

  it("parses an issue with zero cost and value", () => {
    const parsed = parseWarehouseDocumentLines("issue", [
      { inventoryItemId: "a", quantity: "3", unitCost: "999999" },
    ]);
    expect(parsed.kind).toBe("issue");
    expect(parsed.lines[0].unitCost).toBe("0");
    expect(parsed.lines[0].value).toBe("0");
    expect(parsed.totalValue).toBe("0");
  });

  it("refuses a receipt line with no value", () => {
    // Exact costing forbids a lot holding quantity at zero value (0015's
    // `inventory_lot_exact_value_bounds`), so a costless receipt cannot be
    // represented: it used to abort the transaction with a CHECK violation
    // under FIFO, and add cost-basis-free stock under weighted average.
    expect(() =>
      parseWarehouseDocumentLines("receipt", [{ inventoryItemId: "a", quantity: "2" }]),
    ).toThrow("receipt_value_required");
    expect(() =>
      parseWarehouseDocumentLines("receipt", [
        { inventoryItemId: "a", quantity: "2", unitCost: "0" },
      ]),
    ).toThrow("receipt_value_required");
  });

  it("refuses a receipt line whose value rounds away to zero", () => {
    // 0.004 × 100 = 0.4 Rial → rounds to 0. Quantity is real, value is not.
    expect(() =>
      parseWarehouseDocumentLines("receipt", [
        { inventoryItemId: "a", quantity: "0.004", unitCost: "100" },
      ]),
    ).toThrow("receipt_value_required");
  });

  it("keeps an issue line valueless — the costing path prices it", () => {
    const parsed = parseWarehouseDocumentLines("issue", [{ inventoryItemId: "a", quantity: "2" }]);
    expect(parsed.lines[0].unitCost).toBe("0");
    expect(parsed.totalValue).toBe("0");
  });

  it("refuses a unit cost past what a bigint Rial column holds", () => {
    // 2^63 — one past the ceiling. Reaching the INSERT with this aborted the
    // transaction with «out of range for type bigint», i.e. a 500 for a typo.
    expect(() =>
      parseWarehouseDocumentLines("receipt", [
        { inventoryItemId: "a", quantity: "1", unitCost: "9223372036854775808" },
      ]),
    ).toThrow("rial_out_of_range");
  });

  it("refuses a total past the ceiling even when every line fits", () => {
    expect(() =>
      parseWarehouseDocumentLines("receipt", [
        { inventoryItemId: "a", quantity: "1", unitCost: "9223372036854775807" },
        { inventoryItemId: "b", quantity: "1", unitCost: "9223372036854775807" },
      ]),
    ).toThrow("rial_out_of_range");
  });

  it("accepts a unit cost exactly at the ceiling", () => {
    const parsed = parseWarehouseDocumentLines("receipt", [
      { inventoryItemId: "a", quantity: "1", unitCost: "9223372036854775807" },
    ]);
    expect(parsed.totalValue).toBe("9223372036854775807");
  });

  it("rejects an empty document", () => {
    expect(() => parseWarehouseDocumentLines("receipt", [])).toThrow("no_items");
  });

  it("rejects a line without an item", () => {
    expect(() =>
      parseWarehouseDocumentLines("receipt", [{ quantity: "1", unitCost: "100" }]),
    ).toThrow("invalid_line");
  });

  it("rejects the same item twice in one document", () => {
    expect(() =>
      parseWarehouseDocumentLines("receipt", [
        { inventoryItemId: "a", quantity: "1", unitCost: "100" },
        { inventoryItemId: "a", quantity: "2", unitCost: "100" },
      ]),
    ).toThrow("invalid_line");
  });

  it("rejects zero and negative quantities", () => {
    expect(() =>
      parseWarehouseDocumentLines("receipt", [{ inventoryItemId: "a", quantity: "0", unitCost: "100" }]),
    ).toThrow("invalid_quantity");
    expect(() =>
      parseWarehouseDocumentLines("issue", [{ inventoryItemId: "a", quantity: "-1" }]),
    ).toThrow("invalid_quantity");
  });

  it("rejects a non-integer Rial unit cost", () => {
    expect(() =>
      parseWarehouseDocumentLines("receipt", [{ inventoryItemId: "a", quantity: "1", unitCost: "10.5" }]),
    ).toThrow("invalid_rial");
  });

  it("rejects a negative unit cost", () => {
    expect(() =>
      parseWarehouseDocumentLines("receipt", [{ inventoryItemId: "a", quantity: "1", unitCost: "-5" }]),
    ).toThrow("invalid_rial");
  });

  it("canonicalises a trailing-zero quantity", () => {
    const parsed = parseWarehouseDocumentLines("issue", [{ inventoryItemId: "a", quantity: "2.50" }]);
    expect(parsed.lines[0].quantity).toBe("2.5");
  });
});

describe("kind → ledger mapping", () => {
  it("maps kinds to their movement and event types", () => {
    expect(movementTypeFor("receipt")).toBe("warehouse_in");
    expect(movementTypeFor("issue")).toBe("warehouse_out");
    expect(eventTypeFor("receipt")).toBe("warehouse_receipt");
    expect(eventTypeFor("issue")).toBe("warehouse_issue");
  });
});
