/**
 * Phase 24 Wave 3 — the registry of encrypted columns.
 *
 * One place that says which column is protected, under which scheme, and by
 * which physical columns. `integration/field-encryption.integration.test.ts`
 * asserts it against `information_schema.columns` — the same mechanism
 * `tenant-isolation.integration.test.ts` uses against `pg_policy`, and the
 * thing that stops a future migration quietly adding a plaintext PII column
 * or dropping an `_enc` column out from under the services.
 *
 * The rule this registry encodes, from the phase doc: **encrypt a column only
 * if it is never used in a `WHERE` range, an `ORDER BY`, a `GROUP BY`, or an
 * aggregate. Equality-only lookup is permitted via a blind index. Everything
 * else stays plaintext.** Every money `bigint`, every timestamp, every foreign
 * key, `orders.*`, the journal, roles, statuses and `users.full_name` are Tier
 * C — never encrypted, because encrypting any of them breaks the ledger and
 * the reports.
 */

export type EncryptionTier = "Tier A" | "Tier B";

export interface EncryptedColumn {
  /** The plaintext column, still present during the transition window. */
  column: string;
  /** The `bytea` twin holding the POSFLD1 envelope. */
  encColumn: string;
  /** Present only where equality lookup has to keep working. */
  bidxColumn?: string;
  tier: EncryptionTier;
  /** Why this column is encrypted / what the blind index costs. */
  note: string;
}

export interface EncryptedTable {
  /** Which key the envelope is under. */
  scope: "business";
  columns: EncryptedColumn[];
}

export const ENCRYPTED_TABLES: Record<string, EncryptedTable> = {
  customers: {
    scope: "business",
    columns: [
      {
        column: "phone",
        encColumn: "phone_enc",
        bidxColumn: "phone_bidx",
        tier: "Tier B",
        note:
          "Backs lookup at the till. The blind index keeps exact match working; partial and " +
          "prefix search against the phone stop working once the plaintext column is dropped — " +
          "an accepted, deliberate loss recorded in the phase doc.",
      },
      {
        column: "address",
        encColumn: "address_enc",
        tier: "Tier B",
        note: "Delivery address. Displayed on a single customer, never filtered, sorted or grouped.",
      },
      {
        column: "notes",
        encColumn: "notes_enc",
        tier: "Tier B",
        note: "Free text about a person. Never queried — the highest-sensitivity, lowest-cost column here.",
      },
    ],
  },
  reservations: {
    scope: "business",
    columns: [
      {
        column: "customer_phone",
        encColumn: "customer_phone_enc",
        bidxColumn: "customer_phone_bidx",
        tier: "Tier B",
        note: "The walk-in's callback number. Blind-indexed so 'find this caller's booking' still works.",
      },
    ],
  },
};

/**
 * Tier A — pure secrets, zero query impact, listed here because the phase doc
 * calls them the highest value-to-cost ratio in the wave and the next person
 * should not have to re-derive the list from the prose.
 *
 * Not yet materialised, and the integration test therefore does not assert
 * them. Two of the three original entries no longer exist as written:
 * `platform_ai_config` was dropped by `0124_ai_litellm_only.sql` (its key
 * lives on as `platform_ai_gateway.master_key`), and the Kavenegar key
 * arrived already encrypted — `platform_sms_config.api_key_enc`, Wave 2 — so
 * it is done rather than pending.
 */
export const TIER_A_PENDING: { table: string; column: string; note: string }[] = [
  {
    table: "platform_ai_gateway",
    column: "master_key",
    note: "A live LiteLLM key. Platform scope, so it wraps under the KEK directly, not a business DEK.",
  },
  {
    table: "platform_update_config",
    column: "s3_secret_access_key",
    note: "A dump of this table today yields live S3 credentials.",
  },
];

/**
 * Back-compatible shape: `table → column → tier`. Kept because it reads well
 * at a glance and because the original Wave 3 stub exported it.
 */
export const ENCRYPTED_COLUMNS: Record<string, Record<string, EncryptionTier>> = Object.fromEntries(
  Object.entries(ENCRYPTED_TABLES).map(([table, spec]) => [
    table,
    Object.fromEntries(spec.columns.map((c) => [c.column, c.tier])),
  ]),
);

/** Every physical column this wave adds, for the schema assertion. */
export function encryptedPhysicalColumns(): { table: string; column: string; dataType: string }[] {
  const out: { table: string; column: string; dataType: string }[] = [];
  for (const [table, spec] of Object.entries(ENCRYPTED_TABLES)) {
    for (const col of spec.columns) {
      out.push({ table, column: col.encColumn, dataType: "bytea" });
      if (col.bidxColumn) out.push({ table, column: col.bidxColumn, dataType: "text" });
    }
  }
  return out;
}

export function encryptedColumnsFor(table: string): EncryptedColumn[] {
  return ENCRYPTED_TABLES[table]?.columns ?? [];
}

export function isEncryptedColumn(table: string, column: string): boolean {
  return encryptedColumnsFor(table).some((c) => c.column === column);
}
