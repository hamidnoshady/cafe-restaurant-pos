/**
 * Report export — CSV/Excel. Works on a generic tabular shape ({columns,
 * rows}) so it doesn't care whether the rows came from a raw standard-report
 * view dump or an aggregated dim/value custom-report query — the caller
 * (the export API route) is what decides which columns to show.
 *
 * CSV building (rowsToCsv) is a pure string function and unit tested.
 * Excel building needs exceljs (I/O-adjacent, like xlsx-import.ts) so it
 * isn't — same split the repo already uses elsewhere.
 */
import ExcelJS from "exceljs";
import { toPersianDigits } from "./digits";
import { formatJalali } from "./jalali";

export interface ReportColumn {
  key: string;
  label: string;
}

export interface ReportTable {
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

/** DB date/timestamp columns (e.g. a date-bucketed dimension) come back as JS Date objects — shown in Jalali, like everywhere else in the app (dates are stored ISO/Gregorian, Jalali is display-only). */
export function cellValue(value: unknown): string | number {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return toPersianDigits(formatJalali(value));
  if (typeof value === "number") return value;
  // jsonb columns and array columns (e.g. permissions, invitations.location_ids) —
  // otherwise Object/Array would stringify to "[object Object]"/no useful text.
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvCell(value: unknown): string {
  const s = String(cellValue(value));
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** UTF-8 BOM prefix so Excel opens Persian text correctly without a manual encoding prompt. */
export function rowsToCsv(table: ReportTable): string {
  const header = table.columns.map((c) => csvCell(c.label)).join(",");
  const lines = table.rows.map((row) => table.columns.map((c) => csvCell(row[c.key])).join(","));
  return "﻿" + [header, ...lines].join("\r\n");
}

export async function rowsToXlsxBuffer(table: ReportTable, sheetName: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31), { views: [{ rightToLeft: true }] });
  sheet.columns = table.columns.map((c) => ({ header: c.label, key: c.key, width: Math.max(c.label.length + 4, 14) }));
  sheet.getRow(1).font = { bold: true };
  for (const row of table.rows) {
    sheet.addRow(Object.fromEntries(table.columns.map((c) => [c.key, cellValue(row[c.key])])));
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
