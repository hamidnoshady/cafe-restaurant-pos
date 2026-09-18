export const MAX_ONLINE_PLATFORM_COMMISSION_PERCENT = 100;

/** The percentage range a platform contract can use. */
export function validCommissionPercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_ONLINE_PLATFORM_COMMISSION_PERCENT
  );
}

/**
 * Parse the value of the contract-rate field without allowing JavaScript's
 * permissive Number() coercions (for example, an exponent or an empty string)
 * to sneak through. The input component normally hands us ASCII text, but this
 * also accepts pasted Persian/Arabic digits and the Persian decimal mark.
 *
 * A null value is intentional: it is how the UI clears a rate and means "no
 * commission configured", not an invalid request.
 */
export function parseCommissionPercentInput(
  raw: string,
): { ok: true; value: number | null } | { ok: false } {
  let trimmed = raw.trim().replace(/[\u066C\s]/g, "");
  trimmed = trimmed
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/٫/g, ".");

  // A comma is a decimal separator for many users typing on a Latin keyboard.
  // With grouping disabled in the field, a single comma is unambiguous here;
  // Arabic thousands punctuation (٬) was removed above.
  if (!trimmed.includes(".") && (trimmed.match(/,/g) ?? []).length === 1) {
    trimmed = trimmed.replace(",", ".");
  } else {
    trimmed = trimmed.replace(/,/g, "");
  }

  if (trimmed === "") return { ok: true, value: null };
  if (!/^\d+(?:\.\d*)?$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  return validCommissionPercent(value) ? { ok: true, value } : { ok: false };
}
