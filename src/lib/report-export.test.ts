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
    const lines = csv.slice(1).split("\r\n");
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
    expect(rowsToCsv(table).slice(1)).toBe("A");
  });
});
