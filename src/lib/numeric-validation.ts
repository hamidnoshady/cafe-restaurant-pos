/**
 * Validation for canonical numeric text.
 *
 * Localized input belongs in `digits.ts`; these helpers deliberately accept
 * only the ASCII representation that may cross an application/API boundary.
 * They never use Number/parseFloat, so exponent notation, partial parses and
 * IEEE-754 rounding cannot accidentally validate persisted values.
 */

export type NumericValidationCode =
  | "required"
  | "invalid"
  | "integer_required"
  | "positive_required"
  | "non_negative_required"
  | "precision_exceeded"
  | "percentage_range"
  | "rial_range";

export interface NumericValidationResult {
  valid: boolean;
  code?: NumericValidationCode;
  message?: string;
}

export interface DecimalTextConstraints {
  allowNegative?: boolean;
  allowZero?: boolean;
  integer?: boolean;
  maximumScale?: number;
  required?: boolean;
}

const UNSIGNED_DECIMAL_TEXT = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const SIGNED_DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.(\d+))?$/;
const OK: NumericValidationResult = { valid: true };

/** Canonical grammar predicates shared by API/domain parsers. */
export function isCanonicalUnsignedDecimalText(value: string): boolean {
  return UNSIGNED_DECIMAL_TEXT.test(value);
}

export function isCanonicalUnsignedIntegerText(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value);
}

function error(code: NumericValidationCode, message: string): NumericValidationResult {
  return { valid: false, code, message };
}

/** Validate already-normalized ASCII decimal text without floating-point conversion. */
export function validateDecimalText(
  input: string,
  constraints: DecimalTextConstraints = {},
): NumericValidationResult {
  const {
    allowNegative = false,
    allowZero = true,
    integer = false,
    maximumScale,
    required = true,
  } = constraints;
  const value = input.trim();

  if (!value) return required ? error("required", "مقدار را وارد کنید.") : OK;
  const match = (allowNegative ? SIGNED_DECIMAL_TEXT : UNSIGNED_DECIMAL_TEXT).exec(value);
  if (!match) {
    if (integer && /^-?(?:0|[1-9]\d*)\.\d+$/.test(value)) {
      return error("integer_required", "تعداد باید عدد صحیح باشد.");
    }
    return error("invalid", "مقدار واردشده معتبر نیست.");
  }

  const fraction = match[1] ?? "";
  if (integer && fraction) return error("integer_required", "تعداد باید عدد صحیح باشد.");
  if (maximumScale !== undefined && fraction.length > maximumScale) {
    const persianScale = String(maximumScale).replace(/\d/g, (digit) => "۰۱۲۳۴۵۶۷۸۹"[Number(digit)]);
    return error("precision_exceeded", `مقدار می‌تواند حداکثر ${persianScale} رقم اعشار داشته باشد.`);
  }
  if (!allowZero && isCanonicalZero(value)) {
    return error("positive_required", "مقدار باید بزرگ‌تر از صفر باشد.");
  }
  return OK;
}

/** Exact zero check for canonical decimal text. */
export function isCanonicalZero(value: string): boolean {
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  return /^0(?:\.0+)?$/.test(unsigned);
}

export function validatePositiveDecimalText(input: string, maximumScale?: number): NumericValidationResult {
  return validateDecimalText(input, { allowNegative: false, allowZero: false, maximumScale });
}

export function validateNonNegativeDecimalText(input: string, maximumScale?: number): NumericValidationResult {
  return validateDecimalText(input, { allowNegative: false, allowZero: true, maximumScale });
}

export function validateIntegerText(input: string, allowNegative = false): NumericValidationResult {
  return validateDecimalText(input, { allowNegative, integer: true });
}

export function validatePositiveIntegerText(input: string): NumericValidationResult {
  return validateDecimalText(input, { allowNegative: false, allowZero: false, integer: true });
}

export function validateCountText(input: string, allowZero = false): NumericValidationResult {
  return validateDecimalText(input, { allowNegative: false, allowZero, integer: true });
}

/** Percentages use exact text comparison and are constrained to 0..100. */
export function validatePercentageText(input: string, maximumScale = 4): NumericValidationResult {
  const result = validateNonNegativeDecimalText(input, maximumScale);
  if (!result.valid) return result;
  const [integer] = input.split(".");
  if (integer.length > 3 || BigInt(integer) > 100n || (integer === "100" && /\.\d*[1-9]/.test(input))) {
    return error("percentage_range", "درصد باید بین ۰ تا ۱۰۰ باشد.");
  }
  return OK;
}

/** Inventory quantity contract: positive, unsigned, at most 9 decimal places. */
export function validateQuantityText(input: string): NumericValidationResult {
  return validatePositiveDecimalText(input, 9);
}

/** Rial contract: a whole, non-negative PostgreSQL bigint. */
export function validateMoneyText(input: string, allowZero = true): NumericValidationResult {
  const result = validateDecimalText(input, { allowNegative: false, allowZero, integer: true });
  if (!result.valid) return result;
  if (BigInt(input) > 9_223_372_036_854_775_807n) {
    return error("rial_range", "مبلغ واردشده بیش از حد مجاز است.");
  }
  return OK;
}

/** Compare valid unsigned decimal strings without converting them to numbers. */
export function compareUnsignedDecimalText(left: string, right: string): -1 | 0 | 1 {
  const parts = (value: string) => {
    const [integer, fraction = ""] = value.split(".");
    return { integer: integer.replace(/^0+(?=\d)/, ""), fraction: fraction.replace(/0+$/, "") };
  };
  const a = parts(left);
  const b = parts(right);
  if (a.integer.length !== b.integer.length) return a.integer.length < b.integer.length ? -1 : 1;
  if (a.integer !== b.integer) return a.integer < b.integer ? -1 : 1;
  const scale = Math.max(a.fraction.length, b.fraction.length);
  const af = a.fraction.padEnd(scale, "0");
  const bf = b.fraction.padEnd(scale, "0");
  return af === bf ? 0 : af < bf ? -1 : 1;
}
