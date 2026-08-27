import { describe, expect, it } from "vitest";
import { holooDateToIso, mapAccount, mapGoods, mapOpeningInventory, mapPerson } from "./mappers";

describe("holooDateToIso", () => {
  it("passes a Gregorian ISO datetime through", () => {
    expect(holooDateToIso("2024-03-01T10:00:00")).toBe("2024-03-01");
    expect(holooDateToIso("2024-03-01")).toBe("2024-03-01");
  });
  it("converts a Jalali date string to ISO", () => {
    // 1402/12/10 ≈ 2024-02-29
    expect(holooDateToIso("1402/12/10")).toBe("2024-02-29");
    expect(holooDateToIso("1402-12-10")).toBe("2024-02-29");
  });
  it("converts a packed Jalali integer", () => {
    expect(holooDateToIso(14021210)).toBe("2024-02-29");
  });
  it("returns null for empty/unknown", () => {
    expect(holooDateToIso(null)).toBeNull();
    expect(holooDateToIso(undefined)).toBeNull();
    expect(holooDateToIso("")).toBeNull();
    expect(holooDateToIso("not a date")).toBeNull();
  });
});

describe("mapGoods", () => {
  it("maps price to Rial and trims optional fields", () => {
    const mapped = mapGoods({ id: "g1", name: "قند", sku: " 123 ", price: "1200", unit: " کیلو " }, "toman");
    expect(mapped).toEqual({ remoteId: "g1", name: "قند", sku: "123", priceRial: 12000n, unit: "کیلو" });
  });
  it("returns null price for unpriced goods", () => {
    expect(mapGoods({ id: "g2", name: "بدون قیمت", price: null }, "rial").priceRial).toBeNull();
  });
});

describe("mapPerson", () => {
  it("maps a supplier and a customer", () => {
    expect(mapPerson({ id: "p1", name: " علی ", phone: " 0912 ", address: " تهران ", isSupplier: true })).toEqual({
      remoteId: "p1",
      name: "علی",
      phone: "0912",
      address: "تهران",
      isSupplier: true,
    });
    expect(mapPerson({ id: "p2", name: "رضا" }).isSupplier).toBe(false);
  });
});

describe("mapAccount", () => {
  it("maps the account-coding row", () => {
    expect(mapAccount({ id: "a1", code: " 1101 ", name: " صندوق ", nature: "debit", parentCode: "11" })).toEqual({
      remoteId: "a1",
      code: "1101",
      name: "صندوق",
      nature: "debit",
      parentCode: "11",
    });
  });
});

describe("mapOpeningInventory", () => {
  it("maps quantity and cost into a cutover stock row", () => {
    expect(mapOpeningInventory({ id: "s1", goodsId: "g1", name: "قهوه", unit: "kg", quantity: "2.5", unitCost: "1000" }, "toman")).toEqual({
      remoteId: "s1",
      goodsRemoteId: "g1",
      name: "قهوه",
      unit: "kg",
      quantity: "2.5",
      unitCostRial: 10000n,
    });
  });
});
