import { describe, expect, it } from "vitest";
import { parseMenuCsv, parsePrice } from "./menu-import";

describe("advanced menu import", () => {
  it("parses tax and modifier columns", () => {
    const result = parseMenuCsv(
      "دسته,نام,قیمت,مالیات,گروه افزودنی,حداقل انتخاب,حداکثر انتخاب,افزودنی‌ها\n" +
        "نوشیدنی,لاته,140000,10,نوع شیر,1,1,شیر معمولی:0 | شیر بادام:25000",
    );

    expect(result.errors).toEqual([]);
    expect(result.items[0]).toMatchObject({
      category: "نوشیدنی",
      name: "لاته",
      price: 1_400_000,
      taxRate: 10,
      modifierGroup: "نوع شیر",
      modifierMinSelect: 1,
      modifierMaxSelect: 1,
    });
    expect(result.items[0].modifiers).toEqual([
      { name: "شیر معمولی", priceDelta: 0 },
      { name: "شیر بادام", priceDelta: 250_000 },
    ]);
  });

  it("reports modifiers without a group", () => {
    const result = parseMenuCsv("دسته,نام,قیمت,افزودنی‌ها\nنوشیدنی,لاته,140000,شیر بادام:25000");
    expect(result.items).toEqual([]);
    expect(result.errors[0]).toContain("گروه افزودنی");
  });

  it("reads a Rial-denominated file as Rial (Settings passes the business unit)", () => {
    const result = parseMenuCsv(
      "دسته,نام,قیمت,گروه افزودنی,افزودنی‌ها\n" +
        "نوشیدنی,لاته,1400000,نوع شیر,شیر بادام:250000",
      "rial",
    );
    expect(result.errors).toEqual([]);
    expect(result.items[0].price).toBe(1_400_000);
    expect(result.items[0].modifiers).toEqual([
      { name: "شیر بادام", priceDelta: 250_000 },
    ]);
  });

  it("defaults to Toman so the onboarding wizard keeps its documented behaviour", () => {
    expect(parsePrice("85000")).toBe(850_000);
    expect(parsePrice("85000", "toman")).toBe(850_000);
    expect(parsePrice("850000", "rial")).toBe(850_000);
  });
});
