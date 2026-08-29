/**
 * Iranian mobile/landline number normalisation — pure, framework-free.
 *
 * Every CRM question that matters is asked *about a person*, and the only
 * identifier a café or a shop actually collects is a phone number typed by a
 * different person each time. `۰۹۱۲۱۲۳۴۵۶۷`, `+98 912 123 4567`,
 * `00989121234567` and `9121234567` are one customer, and until they are one
 * *string* the segment counts are wrong, duplicate detection finds nothing,
 * and a later messaging phase sends the same SMS twice.
 *
 * So this file answers exactly one question — "what is the canonical form of
 * this number" — and every other CRM module asks it rather than doing its own
 * trimming. Two forms come out:
 *
 * - **E.164** (`+989121234567`) — the canonical, stored/compared form.
 * - **national** (`09121234567`) — what an Iranian reads and dials.
 *
 * Deliberately conservative: a number that is *not* recognisably Iranian comes
 * back `valid: false` with its digits preserved rather than being coerced into
 * a shape it never had. A wrong merge is worse than an un-merged duplicate, and
 * the merge path (crm-duplicates) keys off `e164`, so silence here is safety.
 */

import { toLatinDigits } from "./digits";

/** Iran's country calling code, without the plus. */
export const IRAN_COUNTRY_CODE = "98";

/**
 * Iranian mobile prefixes are `9` + one of these operator digits. Kept as a
 * range check rather than a list of MNO prefixes (091x, 093x, 090x, …): the
 * regulator issues new blocks, and a stricter list would reject real customers
 * of a network that launched after this file was written.
 */
const MOBILE_NATIONAL_LENGTH = 10; // 9xxxxxxxxx, no leading zero

export type PhoneKind = "mobile" | "landline" | "unknown";

export interface NormalizedPhone {
  /** Whether this parsed as a recognisable Iranian number. */
  valid: boolean;
  /** Canonical `+98…` form — the value to store, compare and de-duplicate on. Null when invalid. */
  e164: string | null;
  /** What a user reads: `09121234567` / `02112345678`. Null when invalid. */
  national: string | null;
  kind: PhoneKind;
  /** Every digit we could extract, always present — so an unparsable value is still searchable. */
  digits: string;
}

const INVALID: Omit<NormalizedPhone, "digits"> = {
  valid: false,
  e164: null,
  national: null,
  kind: "unknown",
};

/**
 * Strip a number down to its digits, translating Persian/Arabic-Indic digits
 * first. Separators people actually type — spaces, dashes, parentheses, dots,
 * the RTL/LTR marks a copy-paste out of Word carries — all disappear.
 */
export function phoneDigits(input: string | null | undefined): string {
  if (!input) return "";
  return toLatinDigits(String(input)).replace(/\D+/g, "");
}

/**
 * Reduce a written number to its *national significant* digits — country code
 * and trunk prefix removed — so `+98912…`, `0098912…`, `0912…` and `912…` all
 * become `912…`.
 */
function nationalSignificant(raw: string): string | null {
  let digits = raw;
  // 00 98 … (international prefix) → 98 …
  if (digits.startsWith(`00${IRAN_COUNTRY_CODE}`)) digits = digits.slice(2);
  // 98 … — only when what follows can be a real national number. Without this
  // guard a Tehran landline written 9821… would lose its own leading digits.
  if (digits.startsWith(IRAN_COUNTRY_CODE) && digits.length >= 12) {
    digits = digits.slice(IRAN_COUNTRY_CODE.length);
  }
  // Trunk prefix: a national number is dialled with a leading 0 inside Iran.
  if (digits.startsWith("0")) digits = digits.replace(/^0+/, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Normalise a phone number as typed by a human into the canonical forms the
 * CRM compares on.
 *
 * Mobiles are the only numbers treated as fully canonical, because they are
 * the only ones a later messaging phase can send to. A landline still
 * normalises (so the customer file shows one consistent value) but is labelled
 * `landline`, and consent/SMS paths can refuse it on that basis instead of
 * discovering at send time that the "mobile" was a shop's front desk.
 */
export function normalizePhone(input: string | null | undefined): NormalizedPhone {
  const digits = phoneDigits(input);
  if (!digits) return { ...INVALID, digits: "" };

  const significant = nationalSignificant(digits);
  if (!significant) return { ...INVALID, digits };

  // Mobile: 9 followed by 9 more digits (10 total), e.g. 912 123 4567.
  if (significant.length === MOBILE_NATIONAL_LENGTH && significant.startsWith("9")) {
    return {
      valid: true,
      e164: `+${IRAN_COUNTRY_CODE}${significant}`,
      national: `0${significant}`,
      kind: "mobile",
      digits,
    };
  }

  // Landline: an area code (2-3 digits, never starting 9) plus a subscriber
  // number — 10 significant digits in total on the modern plan, but shorter
  // provincial numbers are still in use, so 6-11 is accepted and labelled.
  if (significant.length >= 6 && significant.length <= 11 && !significant.startsWith("9")) {
    return {
      valid: true,
      e164: `+${IRAN_COUNTRY_CODE}${significant}`,
      national: `0${significant}`,
      kind: "landline",
      digits,
    };
  }

  return { ...INVALID, digits };
}

/** The canonical `+98…` string, or null. The one value duplicate detection keys on. */
export function phoneE164(input: string | null | undefined): string | null {
  return normalizePhone(input).e164;
}

/** Whether this is a mobile — the only thing an SMS can reach. */
export function isMobilePhone(input: string | null | undefined): boolean {
  return normalizePhone(input).kind === "mobile";
}

/**
 * Whether two written numbers are the same person's, ignoring how each was
 * typed. Two *invalid* values are never "the same": junk matching junk would
 * merge unrelated customers, which is the one outcome the merge flow must
 * never produce on its own.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = phoneE164(a);
  const right = phoneE164(b);
  return left !== null && left === right;
}

/**
 * Display form: the national number, grouped the way an Iranian reads it
 * (`0912 123 4567`). Latin digits — the UI converts to Persian digits at the
 * point of render (`toPersianDigits`), the repo's display-only rule.
 */
export function formatPhoneDisplay(input: string | null | undefined): string {
  const { valid, national, kind } = normalizePhone(input);
  if (!valid || !national) return String(input ?? "").trim();
  if (kind === "mobile") {
    return `${national.slice(0, 4)} ${national.slice(4, 7)} ${national.slice(7)}`;
  }
  return national;
}
