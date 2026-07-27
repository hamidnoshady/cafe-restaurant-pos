/**
 * Phase 17 — per-tenant export/restore needs the same "every tenant table"
 * enumeration `integration/tenant-isolation.integration.test.ts` already
 * builds inline for its RLS coverage check, plus a safe INSERT order (a
 * table must follow every table its foreign keys point to). Pulled out here
 * as a reusable helper instead of a second copy of the enumeration query.
 */
import { query } from "./db";

/** Tables with no tenant data — the same list the isolation test exempts (migration 0021 + platform additions). */
export const EXEMPT_TABLES = new Set([
  "schema_migrations",
  "feature_flags",
  "platform_admins",
  "platform_audit_log",
  "plans",
]);

export interface ForeignKeyEdge {
  table: string;
  column: string;
  foreignTable: string;
}

/** Every live base table in the public schema, in no particular order. */
export async function listAllTables(): Promise<string[]> {
  const { rows } = await query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE c.relkind = 'r'
      ORDER BY c.relname`,
  );
  return rows.map((r) => r.relname);
}

/** Every table that carries tenant data — everything except EXEMPT_TABLES. */
export async function listTenantTables(): Promise<string[]> {
  const all = await listAllTables();
  return all.filter((name) => !EXEMPT_TABLES.has(name));
}

/**
 * Every foreign key in the public schema, as (table, column) -> foreignTable
 * triples. Reads pg_constraint/pg_class directly rather than
 * information_schema.constraint_column_usage — that view hides rows the
 * current role lacks certain privileges on (it's designed for introspecting
 * your *own* objects), which silently drops edges when queried as the
 * unprivileged app role rather than the table owner. pg_catalog carries no
 * such filtering, the same reason tenant-isolation.integration.test.ts reads
 * pg_policy/pg_class directly instead of an information_schema equivalent.
 */
export async function listForeignKeys(): Promise<ForeignKeyEdge[]> {
  const { rows } = await query<{ table_name: string; column_name: string; foreign_table_name: string }>(
    `SELECT tc.relname AS table_name, a.attname AS column_name, fc.relname AS foreign_table_name
       FROM pg_constraint c
       JOIN pg_class tc ON tc.oid = c.conrelid
       JOIN pg_class fc ON fc.oid = c.confrelid
       JOIN pg_namespace n ON n.oid = tc.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f'`,
  );
  return rows.map((r) => ({ table: r.table_name, column: r.column_name, foreignTable: r.foreign_table_name }));
}

/**
 * Topologically sorts `tables` so every table appears after every other
 * table (within `tables`) that its foreign keys point to — a safe order to
 * INSERT rows in without hitting a dangling FK. Self-referencing edges
 * (a table pointing at itself, e.g. accounts.parent_id) are ignored here;
 * see `sortRowsByParent` for ordering rows *within* such a table. Falls back
 * to appending anything left over (a genuine cross-table cycle, which
 * doesn't exist in this schema today) rather than looping forever.
 */
export function topoSortTables(tables: string[], edges: ForeignKeyEdge[]): string[] {
  const tableSet = new Set(tables);
  const deps = new Map<string, Set<string>>(tables.map((t) => [t, new Set<string>()]));
  for (const edge of edges) {
    if (edge.table === edge.foreignTable) continue; // self-reference — row-level concern, not table-level
    if (tableSet.has(edge.table) && tableSet.has(edge.foreignTable)) {
      deps.get(edge.table)!.add(edge.foreignTable);
    }
  }

  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  function visit(table: string) {
    if (emitted.has(table) || visiting.has(table)) return;
    visiting.add(table);
    for (const dep of deps.get(table) ?? []) visit(dep);
    visiting.delete(table);
    emitted.add(table);
    order.push(table);
  }

  for (const table of tables) visit(table);
  return order;
}

/** listTenantTables() + listForeignKeys(), sorted into a safe INSERT order. */
export async function tenantTablesInDependencyOrder(): Promise<string[]> {
  const [tables, edges] = await Promise.all([listTenantTables(), listForeignKeys()]);
  return topoSortTables(tables, edges);
}

/**
 * Sorts `rows` so a row never precedes the row its `parentKey` points to
 * (e.g. accounts.parent_id) — the row-level counterpart to `topoSortTables`
 * for a self-referencing table. Safe against cycles (shouldn't occur, but a
 * "visiting" guard means a malformed one degrades to insertion order instead
 * of an infinite loop).
 */
export function sortRowsByParent<T extends Record<string, unknown>>(
  rows: T[],
  idKey: string,
  parentKey: string,
): T[] {
  const byId = new Map(rows.map((r) => [r[idKey], r]));
  const emitted = new Set<unknown>();
  const visiting = new Set<unknown>();
  const out: T[] = [];

  function emit(row: T) {
    const id = row[idKey];
    if (emitted.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const parent = row[parentKey];
    if (parent !== null && parent !== undefined && byId.has(parent)) {
      emit(byId.get(parent)!);
    }
    visiting.delete(id);
    emitted.add(id);
    out.push(row);
  }

  for (const row of rows) emit(row);
  return out;
}

/** Self-referencing FK columns among `tables` (table -> its own parent-pointer column), from listForeignKeys(). */
export function selfReferencingColumns(edges: ForeignKeyEdge[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const edge of edges) {
    if (edge.table === edge.foreignTable) out.set(edge.table, edge.column);
  }
  return out;
}
