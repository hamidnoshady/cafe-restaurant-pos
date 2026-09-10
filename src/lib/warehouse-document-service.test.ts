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

  it("treats a missing receipt unit cost as zero", () => {
    const parsed = parseWarehouseDocumentLines("receipt", [
      { inventoryItemId: "a", quantity: "2" },
    ]);
    expect(parsed.lines[0].unitCost).toBe("0");
    expect(parsed.totalValue).toBe("0");
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
