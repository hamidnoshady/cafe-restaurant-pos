import { describe, expect, it } from "vitest";
import { buildVariantMatrix } from "./variant-matrix";

describe("buildVariantMatrix", () => {
  it("builds the full N×M grid over two axes", () => {
    const cells = buildVariantMatrix(
      "کرم پودر",
      { name: "سایه", values: ["روشن", "تیره"] },
      { name: "حجم", values: ["۳۰ میل", "۵۰ میل"] },
    );
    expect(cells).toHaveLength(4);
    expect(cells[0]).toEqual({
      name: "کرم پودر — روشن — ۳۰ میل",
      attributes: [
        { name: "سایه", value: "روشن" },
        { name: "حجم", value: "۳۰ میل" },
      ],
    });
    // Every cell has a distinct attribute pair.
    const keys = cells.map((c) => c.attributes.map((a) => `${a.name}=${a.value}`).join("|"));
    expect(new Set(keys).size).toBe(4);
  });

  it("supports a single-axis product", () => {
    const cells = buildVariantMatrix("دستبند بافت", { name: "رنگ", values: ["طلایی", "نقره‌ای"] });
    expect(cells.map((c) => c.name)).toEqual(["دستبند بافت — طلایی", "دستبند بافت — نقره‌ای"]);
    expect(cells[0].attributes).toEqual([{ name: "رنگ", value: "طلایی" }]);
  });

  it("de-duplicates and trims axis values", () => {
    const cells = buildVariantMatrix("پایه", { name: "رنگ", values: [" آبی ", "آبی", "سبز"] });
    expect(cells.map((c) => c.attributes[0].value)).toEqual(["آبی", "سبز"]);
  });

  it("refuses an unnamed or empty axis", () => {
    expect(() => buildVariantMatrix("پایه", { name: "", values: ["a"] })).toThrow();
    expect(() => buildVariantMatrix("پایه", { name: "رنگ", values: [] })).toThrow();
  });

  it("refuses two axes with the same name", () => {
    expect(() =>
      buildVariantMatrix("پایه", { name: "رنگ", values: ["a"] }, { name: "رنگ", values: ["b"] }),
    ).toThrow("یکسان");
  });
});
