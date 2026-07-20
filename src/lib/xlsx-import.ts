/**
 * Excel (.xlsx) → string rows for the menu importer.
 * Server-side only (exceljs). First worksheet, first row = header.
 */
import ExcelJS from "exceljs";

export async function xlsxToRows(buffer: ArrayBuffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const rows: string[][] = [];
  sheet.eachRow((row) => {
    const cells: string[] = [];
    // row.values is 1-based; cell 0 is always empty
    const values = row.values as ExcelJS.CellValue[];
    for (let i = 1; i < values.length; i++) {
      cells.push(cellToString(values[i]));
    }
    rows.push(cells);
  });
  return rows;
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("result" in v && v.result !== undefined) return String(v.result);
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
    if (v instanceof Date) return v.toISOString();
    return "";
  }
  return String(v);
}
