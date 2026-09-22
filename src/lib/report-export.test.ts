/**
 * `rowsToCsv` is a thin projection over the platform's one CSV writer
 * (`data-transfer/codecs.ts`) since the data transfer engine consolidated the
 * three copies that existed before it. Two consequences are pinned below:
 *
 *  - the document ends with a line terminator, as the shared writer (and
 *    RFC 4180) has always produced — this file's deleted private copy omitted
 *    it, which is precisely the kind of silent divergence the consolidation
 *    removes;
 *  - a cell beginning `=`, `+`, `-` or `@` is neutralised, which this export
 *    did NOT do before. A report cell is attacker-influenced far more often
 *    than it looks (a customer name, an item name), and Excel executes such a
 *    cell on open.
 */
import { describe, expect, it } from "vitest";
import { rowsToCsv, type ReportTable } from "./report-export";

describe("rowsToCsv", () => {
  it("emits a UTF-8 BOM followed by a header row and data rows", () => {
    const table: ReportTable = {
      columns: [
        { key: "day", label: "روز" },
        { key: "total", label: "جمع" },
      ],
      rows: [
        { day: "2026-01-01", total: 220000 },
        { day: "2026-01-02", total: 150000 },
      ],
    };
    const csv = rowsToCsv(table);
    expect(csv.startsWith("﻿")).toBe(true);
    // Trailing terminator dropped before comparing the rows themselves.
    const lines = csv.slice(1).replace(/\r\n$/, "").split("\r\n");
    expect(lines).toEqual([
      "روز,جمع",
      "2026-01-01,220000",
      "2026-01-02,150000",
    ]);
  });

  it("quotes cells containing commas, quotes, or newlines", () => {
    const table: ReportTable = {
      columns: [{ key: "name", label: "نام" }],
      rows: [{ name: 'a, "b"\nc' }],
    };
    const csv = rowsToCsv(table);
    const dataLine = csv.slice(1).split("\r\n")[1];
    expect(dataLine).toBe('"a, ""b""\nc"');
  });

  it("renders null/undefined cells as empty strings", () => {
    const table: ReportTable = {
      columns: [{ key: "a", label: "A" }, { key: "b", label: "B" }],
      rows: [{ a: null, b: undefined }],
    };
    const csv = rowsToCsv(table);
    const dataLine = csv.slice(1).split("\r\n")[1];
    expect(dataLine).toBe(",");
  });

  it("produces just the header for an empty table", () => {
    const table: ReportTable = { columns: [{ key: "a", label: "A" }], rows: [] };
    expect(rowsToCsv(table).slice(1)).toBe("A\r\n");
  });

  it("neutralises a formula so Excel does not execute it on open", () => {
    // This export had no such guard before the codec consolidation: a report
    // grouped by customer name would happily emit `=HYPERLINK(...)` as a live
    // formula into a file somebody double-clicks.
    const table: ReportTable = {
      columns: [{ key: "name", label: "نام" }],
      rows: [{ name: "=HYPERLINK(\"http://evil\")" }],
    };
    const dataLine = rowsToCsv(table).slice(1).split("\r\n")[1];
    // The apostrophe is what makes it inert; the surrounding quotes are the
    // ordinary CSV escaping of a cell that also contains a double quote.
    expect(dataLine).toContain("'=HYPERLINK");
    expect(dataLine.replace(/^"/, "").startsWith("'=")).toBe(true);
  });
});
