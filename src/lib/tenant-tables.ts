/**
 * Phase 17 — per-tenant export/restore needs the same "every tenant table"
 * enumeration `integration/tenant-isolation.integration.test.ts` needs for its
 * RLS coverage check, plus a safe INSERT order (a table must follow every
 * table its foreign keys point to). `EXEMPT_TABLES` lives here as the single
 * copy — that test imports it rather than keeping a second one, so the two
 * can't drift apart the way they did before (migration 0130 updated the
 * test's list but not this one, so a tenant export silently included global
 * billing catalogue rows and a restore of it collided with the same rows the
 * migration itself seeds).
 */
import { query } from "./db";

/** Tables with no tenant data — every table `integration/tenant-isolation.integration.test.ts` exempts (migration 0021 + platform additions). */
export const EXEMPT_TABLES = new Set([
  "schema_migrations",
  "feature_flags",
  // Migration 0128 — app availability's global half. Same reasoning as
  // feature_flags: a catalogue of deployment-wide states with no business_id.
  // Its per-business counterpart, business_app_availability, is deliberately
  // absent from this list and is RLS-protected like every other tenant table.
  "app_availability",
  "platform_admins",
  "platform_audit_log",
  // Phase 24 — Login lockout for password, platform and directory realms. The attempt
  // happens before any business is known, so it has no business_id. It belongs to
  // the login identity across the platform.
  "auth_login_attempts",
  "mfa_enrolments",
  "mfa_challenges",
  "mfa_recovery_codes",
  "mfa_grace_periods",
  "platform_sms_config",
  // Phase 24 Wave 5 — the durable rate-limit counter (migration 0074). Its
  // keys are IP addresses and hashed bearer tokens, counted before any
  // business is known: the login bucket exists precisely for requests that
  // have no session yet, so there is no business_id to scope by. The row is a
  // key, a count and a window start — no tenant data at all.
  "rate_limits",
  // Phase 17 — a global plan catalogue (branch/member/order-count ceilings),
  // the same shape as feature_flags: every business reads the same few rows,
  // there is nothing to isolate.
  "plans",
  // Platform-wide singleton config for the desktop installer's update
  // distribution (migration 0038) — carries no business_id/location_id,
  // nothing to scope by, same shape as feature_flags/plans.
  "platform_update_config",
  // Phase 18 & Phase 39 — singleton platform provider config (platform_ai_gateway)
  // plus globally shared priced catalogues.
  "ai_credit_packages",
  "ai_subscription_plans",
  // Phase 35 — one deployment-wide VAPID key pair for Web Push (migration
  // 0102). Same shape as platform_ai_gateway: a singleton with no business_id,
  // and rotating it would invalidate every business's registered devices at
  // once, which is exactly why it is not per-tenant. The five notification_*
  // tables that DO carry business data are deliberately not in this list.
  "platform_push_config",
  // Phase 35 — platform-wide prompt-fragment overrides for the assistant
  // (migration 0112). Same shape: no business_id / location_id column,
  // nothing to scope by.
  "ai_prompt_templates",
  // Knowledge base (migration 0117): the super-admin-maintained learning page
  // (a URL) per dashboard section.
  "knowledge_base_entries",
  // Phase 37 & Phase 39 — deployment-wide LLM gateway settings.
  "platform_ai_gateway",
  // Platform billing (migration 0130) — global catalogues/config with no
  // business_id, same shape as feature_flags/plans: the gateway config
  // singleton, the credit-package catalogue and the plan-builder tables.
  // Every business-owned billing table (business_wallets, wallet_ledger,
  // billing_payments, business_entitlements, feature_usage) is RLS-protected
  // and deliberately NOT listed here.
  "platform_payment_config",
  "credit_packages",
  "billing_plans",
  "billing_plan_features",
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
