import { describe, expect, it } from "vitest";
import { searchInventoryItems } from "./inventory-search";

const items = [
  { id: "1", name: "قهوه", sku: "COF-001", unit: "g" },
  { id: "2", name: "شیر", sku: null, unit: "ml" },
  { id: "3", name: "شکر", sku: "SUG-002", unit: "kg" },
  { id: "4", name: "يخ", sku: "ICE-123", unit: "kg" },
];

describe("searchInventoryItems", () => {
  it("returns items unchanged for an empty query", () => {
    expect(searchInventoryItems(items, "")).toEqual(items);
    expect(searchInventoryItems(items, "   ")).toEqual(items);
  });

  it("matches by name", () => {
    expect(searchInventoryItems(items, "قهوه").map((i) => i.id)).toEqual(["1"]);
  });

  it("matches by sku, case-insensitively", () => {
    expect(searchInventoryItems(items, "cof").map((i) => i.id)).toEqual(["1"]);
  });

  it("matches by unit", () => {
    expect(searchInventoryItems(items, "kg").map((i) => i.id)).toEqual(["3", "4"]);
  });

  it("unifies Arabic ي with Persian ی", () => {
    expect(searchInventoryItems(items, "یخ").map((i) => i.id)).toEqual(["4"]);
  });

  it("unifies Arabic/Persian digits", () => {
    expect(searchInventoryItems(items, "۱۲۳").map((i) => i.id)).toEqual(["4"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchInventoryItems(items, "چای")).toEqual([]);
  });
});