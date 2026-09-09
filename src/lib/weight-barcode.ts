/**
 * Phase 42 — EAN-13 weight barcodes («الگوی بارکد وزنی»), pure functions.
 *
 * A weight barcode is the retail standard for goods priced on a scale:
 *
 *   PP | RRRRR | WWWWW | C
 *   2  |   5   |   5   | 1   digits
 *
 * a fixed two-digit prefix (20–29 by convention, the template's «پیش‌شماره»),
 * a five-digit item reference, a five-digit weight in the template's unit,
 * and the EAN-13 check digit. Everything here is a pure string/number
 * function so the template screen's live preview and any future print path
 * compute the same code, and the check-digit math is unit-tested.
 */

export type WeightUnit = "grams" | "kilograms";

export const WEIGHT_UNIT_LABELS: Record<WeightUnit, string> = {
  grams: "گرم",
  kilograms: "کیلوگرم",
};

export function isWeightUnit(value: string): value is WeightUnit {
  return value === "grams" || value === "kilograms";
}

/** The template's fixed prefix: exactly two digits (conventionally 20–29). */
export function validateBarcodePrefix(prefix: string): string | null {
  if (!/^\d{2}$/.test(prefix)) {
    return "پیش‌شماره باید دقیقاً دو رقم باشد.";
  }
  return null;
}

/** EAN-13 check digit over the first twelve digits. */
export function ean13CheckDigit(firstTwelve: string): string {
  if (!/^\d{12}$/.test(firstTwelve)) {
    throw new Error("ean13CheckDigit needs exactly twelve digits");
  }
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    // GS1's rule for EAN-13: odd positions (1-based, left to right) weigh 1
    // and even positions weigh 3 — so the alternating pattern starts at 1.
    const digit = firstTwelve.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

/** True when all thirteen digits satisfy the EAN-13 check-digit rule. */
export function isValidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  return ean13CheckDigit(code.slice(0, 12)) === code[12];
}

const pad = (value: number | string, length: number) =>
  String(value).padStart(length, "0").slice(-length);

/**
 * Builds the full 13-digit code for one template pattern.
 *
 * `itemRef` is truncated to five digits (the board's codes are short), and
 * `weight` is rounded into the template's unit — five digits cap a kilogram
 * reading at 99999 g and a gram reading at 99.999 kg, the same headroom a
 * scale display uses.
 */
export function buildWeightBarcode(args: {
  prefix: string;
  itemRef: string | number;
  weight: number;
  unit: WeightUnit;
}): string {
  const refDigits = String(args.itemRef).replace(/\D/g, "");
  const weightDigits = pad(Math.max(0, Math.round(args.weight)), 5);
  const twelve = pad(args.prefix, 2) + pad(refDigits, 5) + weightDigits;
  return twelve + ean13CheckDigit(twelve);
}

/**
 * A stable sample the template screen previews: prefix + item ref 11111 +
 * a mid-scale weight, so the PP / RRRRR / WWWWW / C segments read like the
 * reference's specimen label.
 */
export function sampleWeightBarcode(prefix: string, unit: WeightUnit): string {
  return buildWeightBarcode({
    prefix,
    itemRef: 11111,
    weight: unit === "grams" ? 1250 : 12,
    unit,
  });
}

/**
 * A fresh EAN-13 for the add-product form's «ایجاد خودکار بارکد»: the
 * template prefix when one exists (so scale-printed stock and the catalogue
 * agree), otherwise 20, plus a time-scrambled five-digit reference.
 */
export function generateItemBarcode(prefix: string, seed: number = Date.now()): string {
  const ref = String(seed % 100000);
  const twelve = pad(prefix, 2).slice(0, 2) + pad(ref, 5) + "00000";
  return twelve + ean13CheckDigit(twelve);
}

/** The human-readable form under the bars: `PP·RRRRR·WWWWWC` grouped. */
export function formatBarcodeHumanReadable(code: string): string {
  if (!/^\d{13}$/.test(code)) return code;
  return `${code.slice(0, 2)} ${code.slice(2, 7)} ${code.slice(7, 12)} ${code.slice(12)}`;
}
