import { describe, expect, it } from "vitest";
import { parseCsv, parseMenuCsv, parsePriceToman, SAMPLE_CSV } from "./menu-import";

describe("parseCsv", () => {
  it("splits simple comma CSV", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles quotes, embedded delimiters and CRLF", () => {
    expect(parseCsv('a,"b,1"\r\n"say ""hi""",d')).toEqual([
      ["a", "b,1"],
      ['say "hi"', "d"],
    ]);
  });

  it("auto-detects semicolon delimiter", () => {
    expect(parseCsv("a;b;c\n1;2;3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("strips BOM and skips blank lines", () => {
    expect(parseCsv("\uFEFFa,b\n\n\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parsePriceToman", () => {
  it("parses Latin digits (Toman → Rial)", () => {
    expect(parsePriceToman("85000")).toBe(850_000);
  });
  it("parses Persian digits with separators", () => {
    expect(parsePriceToman("۱۲۰٬۰۰۰")).toBe(1_200_000);
  });
  it("rejects garbage", () => {
    expect(parsePriceToman("abc")).toBeNull();
    expect(parsePriceToman("")).toBeNull();
    expect(parsePriceToman("-5")).toBeNull();
  });
});

describe("parseMenuCsv", () => {
  it("imports the bundled sample template", () => {
    const result = parseMenuCsv(SAMPLE_CSV);
    expect(result.errors).toEqual([]);
    expect(result.categories).toEqual(["نوشیدنی گرم", "نوشیدنی سرد", "غذا"]);
    expect(result.items).toHaveLength(4);
    expect(result.items[0]).toEqual({
      category: "نوشیدنی گرم",
      name: "اسپرسو",
      price: 850_000,
      description: "تک شات",
      sku: "ESP-1",
    });
  });

  it("accepts English headers", () => {
    const result = parseMenuCsv("category,name,price\nDrinks,Espresso,85000");
    expect(result.errors).toEqual([]);
    expect(result.items[0].price).toBe(850_000);
  });

  it("reports row-level errors and keeps good rows", () => {
    const csv = "دسته,نام,قیمت\nنوشیدنی,چای,۵۰۰۰۰\n,بی‌دسته,1000\nنوشیدنی,قهوه,نامعتبر";
    const result = parseMenuCsv(csv);
    expect(result.items).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain("سطر 3");
    expect(result.errors[1]).toContain("سطر 4");
  });

  it("fails clearly when required headers are missing", () => {
    const result = parseMenuCsv("foo,bar\n1,2");
    expect(result.items).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});
