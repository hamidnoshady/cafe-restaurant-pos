/**
 * Branch (شعبه) input rules — the framework-free half of branch management.
 *
 * `branch-service.ts` is DB-touching and therefore not unit-tested directly
 * (repo convention); everything it can decide *without* a database lives here
 * so it is covered by `branch-input.test.ts` instead — the same split
 * `location-access.ts` has against `setup-state.ts`.
 *
 * Three things are decided here, and each one existed as a bug before:
 *
 *  - **Length and emptiness.** `createBranch` only ever checked `!name`, so a
 *    branch could be created with a 10 000-character name that then broke
 *    every list, receipt and picker that renders it. `updateBranch` was worse:
 *    it folded a blank name into `coalesce($3, name)`, so renaming a branch to
 *    «   » silently kept the old name and still answered `{ ok: true }`.
 *
 *  - **The timezone.** `locations.timezone` is fed straight to
 *    `app_business_date(now(), l.timezone, …)` (migration 0076) by the business
 *    day, every reporting view and the dashboard. Postgres raises
 *    `invalid_parameter_value` on an unknown zone, so one bad POST body used to
 *    poison a branch permanently — every report for it 500s, and there was no
 *    update path for the column to repair it with.
 *
 *  - **Duplicate names.** Two branches called «شعبهٔ مرکزی» are
 *    indistinguishable in the branch switcher, in every per-branch report and
 *    in the warehouse pickers — and the warehouse screens already showed a
 *    «انباری با این نام وجود دارد» message for an error code nothing threw.
 *    `branchNameKey` is the comparison that makes that check real: Arabic vs
 *    Persian yeh/kaf, Persian vs ASCII digits, repeated spaces and case are all
 *    the *same name* to a person typing it twice.
 */

import { toLatinDigits } from "./digits";
import { isBranchColor } from "./branch-color";

export const MAX_BRANCH_NAME = 80;
export const MAX_BRANCH_ADDRESS = 500;
export const MAX_BRANCH_PHONE = 32;

/** What a branch gets when nobody chooses otherwise — unchanged from migration 0001. */
export const DEFAULT_BRANCH_TIMEZONE = "Asia/Tehran";

/**
 * The zones offered in the UI's picker.
 *
 * Deliberately a short, curated list rather than `Intl.supportedValuesOf`:
 * this product is Iran-first, and the realistic answers are Tehran plus the
 * handful of neighbouring zones a business with a branch abroad would need.
 * A value outside the list is still accepted by `branchTimezoneError` (it only
 * asks whether the runtime knows the zone), so an existing branch on an
 * unusual zone keeps it instead of being silently rewritten.
 */
export const COMMON_BRANCH_TIMEZONES: readonly string[] = [
  "Asia/Tehran",
  "Asia/Dubai",
  "Asia/Baghdad",
  "Asia/Qatar",
  "Asia/Kuwait",
  // Istanbul appears once: `Europe/Istanbul` is the canonical IANA zone and
  // `Asia/Istanbul` merely links to it, so listing both put two identical
  // «استانبول» rows in the picker. A branch already stored with the alias
  // keeps it — timezoneOptions folds the current zone back into the list.
  "Europe/Istanbul",
  "Asia/Yerevan",
  "Asia/Baku",
  "Asia/Kabul",
  "Europe/Berlin",
  "Europe/London",
  "UTC",
];

export type BranchFieldError =
  | "missing_fields"
  | "name_too_long"
  | "address_too_long"
  | "phone_too_long"
  | "invalid_timezone"
  | "invalid_color";

/**
 * The name as it should be stored: trimmed, with runs of whitespace collapsed.
 *
 * Collapsing the inside matters as much as trimming the ends — «شعبهٔ  مرکزی»
 * pasted from a spreadsheet is the same branch as «شعبهٔ مرکزی», and storing
 * both makes the duplicate check below a lie.
 */
export function normalizeBranchName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** An optional free-text field as stored: trimmed, empty becoming NULL. */
export function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function branchNameError(value: string | null | undefined): BranchFieldError | null {
  const name = normalizeBranchName(value ?? "");
  if (!name) return "missing_fields";
  if (name.length > MAX_BRANCH_NAME) return "name_too_long";
  return null;
}

export function branchAddressError(value: string | null | undefined): BranchFieldError | null {
  const address = normalizeOptionalText(value);
  if (address && address.length > MAX_BRANCH_ADDRESS) return "address_too_long";
  return null;
}

export function branchPhoneError(value: string | null | undefined): BranchFieldError | null {
  const phone = normalizeOptionalText(value);
  if (phone && phone.length > MAX_BRANCH_PHONE) return "phone_too_long";
  return null;
}

/**
 * Does this runtime know the zone?
 *
 * `Intl.DateTimeFormat` throws `RangeError` for an unknown identifier, which is
 * exactly the set Postgres will also reject — close enough that a value passing
 * here cannot break `app_business_date` later. An empty string is rejected
 * rather than treated as "use the default": the caller decides what absent
 * means, and silently substituting one would hide a typo.
 */
export function isSupportedTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

export function branchTimezoneError(value: string | null | undefined): BranchFieldError | null {
  if (value === null || value === undefined) return null;
  return isSupportedTimezone(value) ? null : "invalid_timezone";
}

/**
 * The key two branch names are compared on when deciding "is this a duplicate".
 *
 * Not a display value and never stored — it deliberately destroys information
 * (case, digit script, Arabic/Persian letter variants, spacing) so that the
 * strings a person would read aloud identically collapse onto one key. A
 * business genuinely wanting «شعبه ۲» and «شعبه 2» as two branches is not a
 * case worth serving; mistaking one for the other at the till is.
 */
export function branchNameKey(value: string): string {
  return toLatinDigits(normalizeBranchName(value))
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\u200c/g, " ")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("fa");
}

/** Whether two branch names would be indistinguishable to the person reading them. */
export function isSameBranchName(a: string, b: string): boolean {
  return branchNameKey(a) === branchNameKey(b);
}

export interface BranchWritableFields {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  timezone?: string | null;
  color?: string | null;
}

/**
 * The branch's identifying colour, validated against the palette (0149's
 * CHECK). Rejected rather than silently defaulted: a client sending a colour
 * the palette does not have has a bug, and quietly painting the branch grey
 * would hide it — and the value is on its way to a CHECK constraint that would
 * answer with a 500 instead of a Persian message.
 */
export function branchColorError(value: string | null | undefined): BranchFieldError | null {
  if (value === null || value === undefined) return null;
  return isBranchColor(value.trim()) ? null : "invalid_color";
}

/**
 * Validates whichever of the writable fields are present.
 *
 * Partial by design: `undefined` means "not being changed" (the PATCH shape),
 * while an explicit `null` on address/phone means "clear it". `name` and
 * `timezone` have no meaningful empty value, so a present-but-blank one is an
 * error rather than a clear — this is the check whose absence let a rename to
 * whitespace report success while doing nothing.
 */
export function branchFieldsError(fields: BranchWritableFields): BranchFieldError | null {
  if (fields.name !== undefined) {
    const error = branchNameError(fields.name);
    if (error) return error;
  }
  if (fields.address !== undefined) {
    const error = branchAddressError(fields.address);
    if (error) return error;
  }
  if (fields.phone !== undefined) {
    const error = branchPhoneError(fields.phone);
    if (error) return error;
  }
  if (fields.timezone !== undefined) {
    if (fields.timezone === null) return "invalid_timezone";
    const error = branchTimezoneError(fields.timezone);
    if (error) return error;
  }
  if (fields.color !== undefined) {
    // Like timezone, there is no "no colour": every branch must be
    // identifiable, so clearing it is not a thing the API offers.
    if (fields.color === null) return "invalid_color";
    const error = branchColorError(fields.color);
    if (error) return error;
  }
  return null;
}
