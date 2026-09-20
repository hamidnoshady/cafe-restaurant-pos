import { describe, expect, it } from "vitest";

import { csvCell, mapHeaders, parseCsv, toCsv, westernDigits } from "./crm-csv";

describe("parseCsv", () => {
  it("parses a plain sheet", () => {
    expect(parseCsv("name,phone\nعلی,0912\nرضا,0913")).toEqual([
      ["name", "phone"],
      ["علی", "0912"],
      ["رضا", "0913"],
    ]);
  });

  it("strips the BOM Excel writes, so the first header is recognised", () => {
    // Without this the importer reports "no name column" on a file that has
    // one, and the user has no way to see why.
    const [header] = parseCsv("\uFEFFname,phone\nعلی,0912");
    expect(header[0]).toBe("name");
  });

  it("keeps a comma inside a quoted field", () => {
    expect(parseCsv('name,city\n"شرکت الف، شعبه ۲",تهران')).toEqual([
      ["name", "city"],
      ["شرکت الف، شعبه ۲", "تهران"],
    ]);
  });

  it("unescapes a doubled quote", () => {
    expect(parseCsv('name\n"کافه ""لاته"""')).toEqual([["name"], ['کافه "لاته"']]);
  });

  it("keeps a newline inside a quoted field as one cell", () => {
    // Multi-line addresses are common and must not split the row.
    const rows = parseCsv('name,address\nعلی,"خیابان الف\nپلاک ۲"');
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toBe("خیابان الف\nپلاک ۲");
  });

  it("handles CRLF", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops trailing blank lines rather than importing an empty customer", () => {
    expect(parseCsv("name\nعلی\n\n\n")).toEqual([["name"], ["علی"]]);
  });

  it("keeps an empty cell in the middle of a row", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ]);
  });
});

describe("westernDigits", () => {
  it("converts Persian digits", () => {
    expect(westernDigits("۰۹۱۲۳۴۵۶۷۸۹")).toBe("09123456789");
  });

  it("converts Arabic-Indic digits", () => {
    expect(westernDigits("٠٩١٢")).toBe("0912");
  });

  it("leaves letters and punctuation alone", () => {
    expect(westernDigits("تهران ۲-الف")).toBe("تهران 2-الف");
  });
});

describe("csvCell", () => {
  it("neutralises a formula so Excel does not execute it", () => {
    // A customer name of =HYPERLINK(...) would otherwise run on the machine of
    // whoever opens the export.
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("+cmd")).toBe("'+cmd");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("quotes cells containing a comma, quote or newline", () => {
    expect(csvCell("الف, ب")).toBe('"الف, ب"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  it("leaves ordinary text unquoted", () => {
    expect(csvCell("علی")).toBe("علی");
  });

  it("does not quote a Persian comma, which is not a delimiter", () => {
    // U+060C is a letter-like punctuation mark in the data, not CSV syntax.
    // Quoting it would be harmless but wrong, and it appears in most Persian
    // company names.
    expect(csvCell("شرکت الف، شعبه ۲")).toBe("شرکت الف، شعبه ۲");
  });

  it("renders null and undefined as empty", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("round-trips through parseCsv", () => {
    // The strongest statement available: anything we export, we can re-import.
    const headers = ["نام", "یادداشت"];
    const rows = [
      ["شرکت الف، شعبه ۲", 'گفت "بله"'],
      ["علی", "خط ۱\nخط ۲"],
    ];
    const parsed = parseCsv(toCsv(headers, rows));
    expect(parsed).toEqual([headers, ...rows]);
  });

  it("emits a BOM so Excel reads Persian correctly", () => {
    expect(toCsv(["نام"], [])).toMatch(/^\uFEFF/);
  });
});

describe("mapHeaders", () => {
  const aliases = { name: ["name", "نام"], phone: ["phone", "موبایل"] };

  it("matches regardless of case and surrounding space", () => {
    expect(mapHeaders([" Name ", "PHONE"], aliases)).toEqual({ name: 0, phone: 1 });
  });

  it("matches a Persian alias", () => {
    expect(mapHeaders(["نام", "موبایل"], aliases)).toEqual({ name: 0, phone: 1 });
  });

  it("omits fields with no matching column", () => {
    expect(mapHeaders(["نام"], aliases)).toEqual({ name: 0 });
  });
});
