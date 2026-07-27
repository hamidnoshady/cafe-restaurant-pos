import { describe, expect, it } from "vitest";
import { parseMenuCsv } from "./menu-import";

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
});
