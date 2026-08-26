/**
 * Phase 26 (issue #125) Wave 3 — the pure planning half of base-data import.
 *
 * Before any write, the importer works out *what* it would do: which goods and
 * customers are new (vs already mapped), and which Holoo accounts map onto the
 * industry's seed chart of accounts rather than being recreated. This module is
 * the pure, unit-tested part of that decision; import-service.ts applies it.
 */
import type { AccountType } from "../../coa-template";
import type { MappedAccount, MappedGoods, MappedPerson } from "./mappers";

// ---------------------------------------------------------------------------
// Goods / customers — "new" is simply "not already mapped".
// ---------------------------------------------------------------------------

export interface EntityPlan<T> {
  /** Rows to create (not previously mapped). */
  toCreate: T[];
  /** Count of rows already mapped and therefore skipped. */
  skipped: number;
}

export function planGoods(goods: MappedGoods[], alreadyMapped: ReadonlySet<string>): EntityPlan<MappedGoods> {
  const toCreate: MappedGoods[] = [];
  let skipped = 0;
  for (const row of goods) {
    if (alreadyMapped.has(row.remoteId)) skipped += 1;
    else toCreate.push(row);
  }
  return { toCreate, skipped };
}

export function planPersons(persons: MappedPerson[], alreadyMapped: ReadonlySet<string>): EntityPlan<MappedPerson> {
  const toCreate: MappedPerson[] = [];
  let skipped = 0;
  for (const row of persons) {
    if (alreadyMapped.has(row.remoteId)) skipped += 1;
    else toCreate.push(row);
  }
  return { toCreate, skipped };
}

// ---------------------------------------------------------------------------
// Accounts — align with the seed chart, don't blindly recreate it.
// ---------------------------------------------------------------------------

/** Iranian account-coding convention: the leading digit names the type. */
export function holooAccountType(code: string, nature?: string | null): AccountType {
  const c = code.trim();
  if (nature?.toLowerCase() === "credit") {
    // A credit-nature account is a liability, equity or revenue source.
    if (/^[23]/.test(c)) return /^3/.test(c) ? "equity" : "liability";
    return "revenue";
  }
  const first = c[0];
  switch (first) {
    case "1":
      return "asset";
    case "2":
      return "liability";
    case "3":
      return "equity";
    case "4":
      return "revenue";
    case "5":
    case "6":
    case "7":
      return "expense";
    default:
      return "asset";
  }
}

export interface AccountImportPlan {
  /** Holoo accounts whose code already exists in the seed chart — map, don't recreate. */
  mappedToSeed: MappedAccount[];
  /** Holoo accounts with codes absent from the seed chart — create fresh. */
  toCreate: MappedAccount[];
  /** Accounts whose parent code is neither in the seed nor among created codes. */
  orphaned: MappedAccount[];
}

export function planAccountImport(holooAccounts: MappedAccount[], seedCodes: ReadonlySet<string>): AccountImportPlan {
  const mappedToSeed: MappedAccount[] = [];
  const toCreate: MappedAccount[] = [];
  const known = new Set<string>(seedCodes);

  for (const account of holooAccounts) {
    if (known.has(account.code)) {
      mappedToSeed.push(account);
    } else {
      toCreate.push(account);
      known.add(account.code); // its children may reference it
    }
  }

  // Re-check parent pointers now that the full code set is known.
  const finalToCreate: MappedAccount[] = [];
  const orphaned: MappedAccount[] = [];
  for (const account of toCreate) {
    if (account.parentCode && !known.has(account.parentCode)) orphaned.push(account);
    else finalToCreate.push(account);
  }

  return { mappedToSeed, toCreate: finalToCreate, orphaned };
}
