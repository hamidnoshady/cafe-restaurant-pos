/**
 * Phase 17 — per-tenant export. The Phase 10 backup system's `pg_dump` is a
 * whole-database artifact with no per-business slicing (documented as a v1
 * assumption in docs/phases/Phase-10-Backup-System.md), and pg_dump has no
 * row-level filter to retrofit one. This builds a per-tenant *logical* dump
 * instead: walk every tenant table, read it inside `withTenant(businessId)`
 * so RLS itself does the filtering (every shape — direct business_id,
 * location_id-via-locations, EXISTS-based child traversal — for free,
 * without re-encoding which shape each table uses), then serialize the
 * result either as restorable SQL (INSERT statements, in dependency order)
 * or as a business-readable Excel workbook (one sheet per table).
 *
 * Restoring that SQL back into a target database is not built yet — this
 * covers the export half of the Phase 17 scope item; see the phase doc.
 */
import ExcelJS from "exceljs";
import { query, withTenant } from "./db";
import { cellValue } from "./report-export";
import { selfReferencingColumns, sortRowsByParent, tenantTablesInDependencyOrder, listForeignKeys } from "./tenant-tables";

export interface TenantExportTable {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Postgres identifiers can't be parameterised; table/column names here come only from information_schema, but validate anyway rather than trust that blindly. */
function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe_identifier: ${name}`);
  return name;
}

/**
 * Reads every row belonging to `businessId` from every tenant table. RLS
 * (running as the caller's own tenant scope) is what actually restricts each
 * SELECT — this never has to know which of the RLS shapes any given table
 * uses. Empty tables are omitted.
 */
export async function exportTenantData(businessId: string): Promise<TenantExportTable[]> {
  const [order, edges] = await Promise.all([tenantTablesInDependencyOrder(), listForeignKeys()]);
  const selfRefs = selfReferencingColumns(edges);

  return withTenant(businessId, async () => {
    const out: TenantExportTable[] = [];
    for (const name of order) {
      const safeName = assertSafeIdentifier(name);
      const { rows, fields } = await query(`SELECT * FROM "${safeName}"`);
      if (rows.length === 0) continue;
      const parentColumn = selfRefs.get(name);
      const orderedRows = parentColumn ? sortRowsByParent(rows, "id", parentColumn) : rows;
      out.push({ name, columns: fields.map((f) => f.name), rows: orderedRows });
    }
    return out;
  });
}

/**
 * Postgres's own `'{a,b}'` array-literal text format — used instead of
 * `ARRAY[...]` because `ARRAY[]` (an empty array, e.g. invitations'
 * default `location_ids`) can't be typed without a cast, while `'{}'` parses
 * fine via assignment cast into any array column type, same as every other
 * scalar value here.
 */
function arrayLiteral(values: unknown[]): string {
  const elements = values.map((v) => {
    if (v === null || v === undefined) return "NULL";
    return `"${String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return `'{${elements.join(",")}}'`;
}

/** A single value as a literal Postgres understands in an INSERT, relying on assignment casts (text -> uuid/timestamptz/jsonb/etc.) for anything beyond the JS-visible type. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value)) return arrayLiteral(value);
  if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Renders an export as a restorable SQL script: one INSERT per row, tables and (within a self-referencing table) rows in dependency order, wrapped in one transaction. */
export function tenantDataToSql(tables: TenantExportTable[]): string {
  const lines: string[] = [
    "-- Per-tenant data export (Phase 17). Restore into an already-migrated,",
    "-- otherwise-empty database — this carries data only, no schema.",
    "BEGIN;",
    // Business-rule triggers (e.g. "an order's items can't change once it's
    // no longer open") police live mutations — every row here already passed
    // through them once, in whatever order produced this exact final state,
    // before export. Replaying that state can hit them anyway (a completed
    // order's items, restored after the order itself, momentarily look like
    // an edit to a closed order). `session_replication_role = replica` is the
    // standard mechanism logical replication itself uses to skip ordinary
    // triggers during a data load; SET LOCAL keeps it scoped to this
    // transaction, reverting automatically on COMMIT or ROLLBACK.
    "SET LOCAL session_replication_role = replica;",
  ];
  for (const table of tables) {
    const safeName = assertSafeIdentifier(table.name);
    const columnList = table.columns.map((c) => `"${assertSafeIdentifier(c)}"`).join(", ");
    for (const row of table.rows) {
      const values = table.columns.map((c) => sqlLiteral(row[c])).join(", ");
      // OVERRIDING SYSTEM VALUE: several tables (stock_movements, journal_lines,
      // audit_log, ...) use `bigint GENERATED ALWAYS AS IDENTITY`, which refuses
      // an explicit id without this clause. Harmless (a no-op) on every other
      // table, so it's simplest to always include it rather than special-case
      // which tables need it.
      lines.push(`INSERT INTO "${safeName}" (${columnList}) OVERRIDING SYSTEM VALUE VALUES (${values});`);
    }
  }
  lines.push("COMMIT;");
  return lines.join("\n");
}

/** Renders an export as one Excel workbook, one sheet per non-empty table. */
export async function tenantDataToXlsxBuffer(tables: TenantExportTable[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const table of tables) {
    const sheet = workbook.addWorksheet(table.name.slice(0, 31), { views: [{ rightToLeft: true }] });
    sheet.columns = table.columns.map((c) => ({ header: c, key: c, width: Math.max(c.length + 4, 14) }));
    sheet.getRow(1).font = { bold: true };
    for (const row of table.rows) {
      sheet.addRow(Object.fromEntries(table.columns.map((c) => [c, cellValue(row[c])])));
    }
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
