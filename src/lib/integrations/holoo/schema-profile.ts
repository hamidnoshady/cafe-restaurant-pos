/**
 * Phase 26 (issue #125) Wave 2 — version-aware Holoo schema profiles.
 *
 * Holoo's table structure differs between versions and editions, and a direct
 * SQL write against a structure we don't recognise would corrupt a customer's
 * legal books. This pure module is the guardrail: it holds *named* profiles
 * that map a supported Holoo edition to the table/column names the adapter
 * reads and writes, and `matchProfile` returns `null` for any structure it does
 * not recognise — which is what Wave 8 uses to refuse `direct_sql` writes.
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

type ColumnName = string;

export interface HolooSchemaColumns {
  goods: {
    id: ColumnName;
    name: ColumnName;
    sku?: ColumnName;
    price?: ColumnName;
    unit?: ColumnName;
    updatedAt?: ColumnName;
  };
  persons: {
    id: ColumnName;
    name: ColumnName;
    phone?: ColumnName;
    address?: ColumnName;
    isSupplier?: ColumnName;
    updatedAt?: ColumnName;
  };
  accounts: {
    id: ColumnName;
    code: ColumnName;
    name: ColumnName;
    nature?: ColumnName;
    parentCode?: ColumnName;
    updatedAt?: ColumnName;
  };
  invoices: {
    id: ColumnName;
    date: ColumnName;
    personId?: ColumnName;
    total: ColumnName;
    updatedAt?: ColumnName;
  };
  invoiceLines: {
    invoiceId: ColumnName;
    goodsId: ColumnName;
    quantity: ColumnName;
    total: ColumnName;
  };
  purchases: {
    id: ColumnName;
    date: ColumnName;
    personId?: ColumnName;
    total: ColumnName;
    updatedAt?: ColumnName;
  };
  receiptPayment: {
    id: ColumnName;
    date: ColumnName;
    personId?: ColumnName;
    amount: ColumnName;
    direction?: ColumnName;
    updatedAt?: ColumnName;
  };
  stockMovements: {
    id: ColumnName;
    date?: ColumnName;
    goodsId: ColumnName;
    quantity: ColumnName;
    unitCost?: ColumnName;
    updatedAt?: ColumnName;
  };
  journal: {
    id: ColumnName;
    date: ColumnName;
    memo?: ColumnName;
    updatedAt?: ColumnName;
  };
  journalLines: {
    journalId: ColumnName;
    accountCode: ColumnName;
    debit: ColumnName;
    credit: ColumnName;
  };
}

export interface HolooSchemaProfile {
  /** Stable key, stored in holoo_connection_settings.schema_profile. */
  key: string;
  /** Human-readable label for the management screen. */
  label: string;
  /** Canonical Holoo table name for each entity on this edition. */
  tables: Record<HolooEntity, string>;
  /** Column mapping for profile-driven reads/writes. */
  columns: HolooSchemaColumns;
}

/**
 * The generic Holoo layout (SQL Server editions). These are the canonical
 * names the probe's CANDIDATE_TABLES matches against; a real install that
 * differs in any *core* table falls through to `null`, which is the safe
 * answer. New editions are added here (not special-cased in the adapter).
 *
 * The column aliases are intentionally conservative and live in the profile,
 * not in the readers. When a real installation exposes a different spelling,
 * the probe output creates a new profile row here rather than a conditional in
 * pull-service.ts/reconciliation-service.ts.
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
    columns: {
      goods: { id: "Code", name: "Name", sku: "BarCode", price: "SellPrice", unit: "UnitName", updatedAt: "ModifiedDate" },
      persons: { id: "Code", name: "Name", phone: "Tel", address: "Address", isSupplier: "IsSupplier", updatedAt: "ModifiedDate" },
      accounts: { id: "Code", code: "Code", name: "Name", nature: "Nature", parentCode: "ParentCode", updatedAt: "ModifiedDate" },
      invoices: { id: "Code", date: "Date", personId: "PersonCode", total: "TotalPrice", updatedAt: "ModifiedDate" },
      invoiceLines: { invoiceId: "InvoiceCode", goodsId: "GoodsCode", quantity: "Quantity", total: "TotalPrice" },
      purchases: { id: "Code", date: "Date", personId: "PersonCode", total: "TotalPrice", updatedAt: "ModifiedDate" },
      receiptPayment: { id: "Code", date: "Date", personId: "PersonCode", amount: "Amount", direction: "Type", updatedAt: "ModifiedDate" },
      stockMovements: { id: "Code", date: "Date", goodsId: "GoodsCode", quantity: "Quantity", unitCost: "UnitCost", updatedAt: "ModifiedDate" },
      journal: { id: "Code", date: "Date", memo: "Description", updatedAt: "ModifiedDate" },
      journalLines: { journalId: "SanadCode", accountCode: "AccountCode", debit: "Debit", credit: "Credit" },
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
