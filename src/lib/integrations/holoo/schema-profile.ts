/**
 * Phase 26 (issue #125) Wave 2 — version-aware Holoo schema profiles.
 *
 * Holoo's table structure differs between versions and editions, and a direct
 * SQL write against a structure we don't recognise would corrupt a customer's
 * legal books. This pure module is the guardrail: it holds *named* profiles
 * that map a supported Holoo edition to the table/column names the adapter
 * reads and writes, and `matchProfile` returns `null` for any structure it
 * does not recognise — which is what Wave 8 uses to refuse `direct_sql` writes.
 *
 * Pure, framework-free, unit-tested. It takes the table names a probe found
 * (the `tables` array of `scripts/holoo-probe.ts`) and returns the matched
 * profile, or `null`.
 */

/** The domain entities the adapter imports/writes, one per Holoo table. */
export type HolooEntity =
  | "goods"
  | "persons"
  | "accounts"
  | "invoices"
  | "invoice_lines"
  | "purchases"
  | "receipt_payment"
  | "stock_movements"
  | "journal"
  | "journal_lines";

export interface HolooSchemaProfile {
  /** Stable key, stored in holoo_connection_settings.schema_profile. */
  key: string;
  /** Human-readable label for the management screen. */
  label: string;
  /** Canonical Holoo table name for each entity on this edition. */
  tables: Record<HolooEntity, string>;
}

/**
 * The generic Holoo layout (SQL Server editions). These are the canonical
 * names the probe's CANDIDATE_TABLES matches against; a real install that
 * differs in any *core* table falls through to `null`, which is the safe
 * answer. New editions are added here (not special-cased in the adapter).
 */
export const HOLOO_PROFILES: HolooSchemaProfile[] = [
  {
    key: "holoo-generic",
    label: "Holoo (SQL Server, canonical)",
    tables: {
      goods: "Goods",
      persons: "Person",
      accounts: "Account",
      invoices: "Invoice",
      invoice_lines: "InvoiceItem",
      purchases: "BuyInvoice",
      receipt_payment: "ReceivePay",
      stock_movements: "Stock",
      journal: "Sanad",
      journal_lines: "SanadRow",
    },
  },
];

/** Entities that must all be present for a structure to be recognised at all. */
const CORE_ENTITIES: HolooEntity[] = ["goods", "persons", "accounts", "invoices", "journal"];

/**
 * Match a probed table list to a known profile.
 *
 * A profile matches only when every one of its *core* tables is present in the
 * probed list. A structure missing any core table — i.e. a Holoo edition we
 * have not catalogued — returns `null`, so callers treat it as unknown rather
 * than guessing at table names.
 */
export function matchProfile(probedTables: readonly string[]): HolooSchemaProfile | null {
  const present = new Set(probedTables.map((t) => t.toLowerCase()));
  for (const profile of HOLOO_PROFILES) {
    const complete = CORE_ENTITIES.every((entity) => present.has(profile.tables[entity].toLowerCase()));
    if (complete) return profile;
  }
  return null;
}

/** The profile with the given key, or null. */
export function profileForKey(key: string): HolooSchemaProfile | null {
  return HOLOO_PROFILES.find((p) => p.key === key) ?? null;
}
