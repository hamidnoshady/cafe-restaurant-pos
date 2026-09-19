import { describe, expect, it } from "vitest";
import {
  buildProductsCsv,
  isVariantParent,
  normalizeListSearch,
  variantMatchesNeedle,
  variantSearchNeedles,
  type ProductListRow,
} from "./product-list";

const row: ProductListRow = {
  name: "انگشتر استیل آبی",
  parentName: "انگشتر استیل",
  sku: "1014",
  barcode: "62600101401",
  unit: "عدد",
  kind: "variant_child",
  quantity: "5.000000000",
  unitPrice: 530000,
  unitCost: 250000,
};

const family: ProductListRow = {
  ...row,
  name: "انگشتر استیل",
  parentName: null,
  barcode: null,
  unit: null,
  kind: "variant_parent",
  quantity: "0.000000000",
  unitPrice: null,
  unitCost: null,
};

describe("normalizeListSearch", () => {
  it("folds Persian and Arabic-Indic digits to ASCII", () => {
    expect(normalizeListSearch("۱۰۱۴")).toBe("1014");
    expect(normalizeListSearch("١٠١٤")).toBe("1014");
  });

  it("lowercases and trims", () => {
    expect(normalizeListSearch("  ABC ")).toBe("abc");
  });
});

describe("variant search", () => {
  const needles = variantSearchNeedles(row);

  it("matches a SKU typed with Persian digits", () => {
    expect(variantMatchesNeedle(needles, normalizeListSearch("۱۰۱"))).toBe(true);
  });

  it("matches a Latin prefix of the barcode", () => {
    expect(variantMatchesNeedle(needles, normalizeListSearch("62600"))).toBe(true);
  });

  it("matches the family name", () => {
    expect(variantMatchesNeedle(needles, normalizeListSearch("استیل"))).toBe(true);
  });

  it("does not match unrelated text", () => {
    expect(variantMatchesNeedle(needles, normalizeListSearch("ساعت"))).toBe(false);
  });

  it("drops empty fields so an all-empty haystack never matches", () => {
    const empty: ProductListRow = { ...row, name: "", parentName: null, sku: null, barcode: null };
    expect(variantMatchesNeedle(variantSearchNeedles(empty), normalizeListSearch("x"))).toBe(false);
  });
});

describe("buildProductsCsv", () => {
  const csv = buildProductsCsv([family, row]);
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n");

  it("starts with a UTF-8 BOM and a quoted header", () => {
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(lines[0]).toBe('"نام","خانواده","کد کالا","بارکد","واحد","موجودی","قیمت فروش (ریال)","قیمت خرید (ریال)"');
  });

  it("emits a data row with Latin digits: trimmed quantity and raw integer Rial prices", () => {
    expect(lines[2]).toBe('"انگشتر استیل آبی","انگشتر استیل","1014","62600101401","عدد","5","530000","250000"');
  });

  it("leaves a family row's stock and price cells empty instead of exporting fake zeros", () => {
    expect(lines[1]).toBe('"انگشتر استیل","","1014","","","","",""');
  });

  it("never Persian-formats any digit in the file (display is not data)", () => {
    expect(csv).not.toMatch(/[۰-۹٠-٩]/);
  });

  it("doubles embedded quotes", () => {
    const quoted = buildProductsCsv([{ ...row, name: 'حلقه "ویژه"' }]);
    expect(quoted).toContain('"حلقه ""ویژه"""');
  });

  it("is not fooled into treating a variant child as the family row", () => {
    expect(isVariantParent(row)).toBe(false);
    expect(isVariantParent(family)).toBe(true);
  });
});
