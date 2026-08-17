/**
 * Phase 27 Wave 4 — barcode validation and generation (pure, framework-free).
 *
 * The same shape as code-alphabet.ts: the one place a person reads, types or
 * pastes a code into the product, with the folding and check-digit rules kept
 * in pure functions so the POS screen can validate a scan before it asks the
 * server anything and the service layer can trust it. No DB, no I/O.
 *
 * Two families of code matter:
 *  - Supplier codes — EAN-13 (13 digits) and UPC-A (12 digits), the two
 *    symbologies a handheld scanner actually emits from printed retail
 *    barcodes. Both carry a check digit computed with the same odd/even
 *    weighting.
 *  - Internal codes — 13-digit EAN-13-shaped codes with the reserved GS1
 *    "in-store" prefix `2`, minted for stock that arrives without a supplier
 *    code. Shaping them like EAN-13 (rather than some custom alphabet) is
 *    what makes "it scans" true on any scanner, with no special config.
 */
import { foldDigits } from "./code-alphabet";

export type BarcodeSymbology = "EAN13" | "UPC" | "internal";

/** The GS1 prefix reserved for in-store / internal use; every generated internal code starts with it. */
export const INTERNAL_BARCODE_PREFIX = "2";

const DIGIT_RE = /^\d+$/;

/**
 * The EAN/UPC check digit: sum the digits at even positions (1-indexed from
 * the right) ×3 plus the odd positions, then the check digit is the amount
 * that rounds that sum up to the next multiple of 10. Shared unchanged by
 * EAN-13 (12 payload digits + 1 check) and UPC-A (11 payload digits + 1).
 */
export function checkDigitFor(payloadDigits: string): string {
  if (!DIGIT_RE.test(payloadDigits) || payloadDigits.length === 0) {
    throw new Error("بارکد باید فقط رقم باشد.");
  }
  const digits = [...payloadDigits].map(Number).reverse();
  let sum = 0;
  // After reversing, "even position from the right" (the one weighted ×3)
  // is index 0, 2, 4, … in the reversed array.
  digits.forEach((d, i) => {
    sum += i % 2 === 0 ? d * 3 : d;
  });
  const check = (10 - (sum % 10)) % 10;
  return String(check);
}

/** Normalise a scanned/pasted code: fold Persian/Arabic-Indic digits and strip surrounding whitespace. */
export function normalizeBarcode(raw: string): string {
  return foldDigits(raw.trim());
}

/** Whether `code` (already normalised) is a structurally valid EAN-13. */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return checkDigitFor(code.slice(0, 12)) === code[12];
}

/** Whether `code` (already normalised) is a structurally valid UPC-A. */
export function isValidUpcA(code: string): boolean {
  if (!/^\d{12}$/.test(code)) return false;
  return checkDigitFor(code.slice(0, 11)) === code[11];
}

/**
 * Classify a normalised code into a symbology, or null if it is not a code
 * this product will accept. Supplier codes must pass their check digit;
 * an internal code is any 13-digit code carrying the reserved prefix whose
 * check digit validates (the same shape EAN-13 scanners read).
 */
export function classifyBarcode(code: string): BarcodeSymbology | null {
  if (isValidEan13(code)) {
    return code.startsWith(INTERNAL_BARCODE_PREFIX) ? "internal" : "EAN13";
  }
  if (isValidUpcA(code)) return "UPC";
  return null;
}

/**
 * Mint a 13-digit internal barcode from an 11-digit payload, in the shape
 * `2 + payload + check`. Pure and deterministic: the caller (the DB-touching
 * service) supplies the payload and re-mints with a different one if the
 * code already exists at the branch.
 */
export function internalBarcodeForPayload(payloadDigits: string): string {
  if (!/^\d{11}$/.test(payloadDigits)) {
    throw new Error("بارکد داخلی باید ۱۱ رقم پایه داشته باشد.");
  }
  const first12 = INTERNAL_BARCODE_PREFIX + payloadDigits;
  return first12 + checkDigitFor(first12);
}

/**
 * A candidate payload for `internalBarcodeForPayload`, derived from an
 * arbitrary non-negative integer. Used with a retry loop for uniqueness, so
 * the generator itself never has to consult the database.
 */
export function internalPayloadFromNumber(n: number): string {
  const value = Math.floor(Math.abs(n));
  return String(value % 100_000_000_000).padStart(11, "0");
}
