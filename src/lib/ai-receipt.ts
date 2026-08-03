/**
 * AI Hub Wave 5 (issue #145) — pure helpers for the "attach a receipt photo"
 * flow. The image is a client-supplied data URL used for exactly one provider
 * call (see `draft_expense_from_receipt` in ai-service.ts) and is never
 * written to any table or object storage — no new migration, no upload
 * endpoint, no storage-lifecycle question to answer. This mirrors the
 * decision to reuse the single existing OpenAI-compatible provider connection
 * (Phase 18's `platform_ai_config`, already vision-capable for both
 * providers' default models) instead of integrating a separate OCR vendor.
 */

/** ~5MB of original file bytes: generous for a phone photo of a receipt. */
export const MAX_RECEIPT_IMAGE_BYTES = 5 * 1024 * 1024;

/** Base64 inflates by ~4/3; cap the encoded string a bit above that ratio. */
const MAX_RECEIPT_DATA_URL_BASE64_LENGTH = Math.ceil((MAX_RECEIPT_IMAGE_BYTES * 4) / 3) + 1024;

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;

export interface ParsedReceiptImage {
  mimeType: string;
  dataUrl: string;
}

/**
 * Validates a client-supplied `data:image/...;base64,...` string without
 * decoding it — format, an allowed image type, and a size ceiling. Returns
 * null for anything else so the caller can refuse the turn with a clear
 * error instead of forwarding an oversized or unsupported payload.
 */
export function parseReceiptImageDataUrl(value: unknown): ParsedReceiptImage | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = DATA_URL_RE.exec(trimmed);
  if (!match) return null;
  const [, mimeType, base64] = match;
  if (!ALLOWED_MIME_TYPES.has(mimeType)) return null;
  if (base64.length === 0 || base64.length > MAX_RECEIPT_DATA_URL_BASE64_LENGTH) return null;
  return { mimeType, dataUrl: trimmed };
}

export interface ReceiptDraftFields {
  vendor: string | null;
  /** ISO date (YYYY-MM-DD), best-effort. */
  expenseDate: string | null;
  /** Integer Rial, best-effort. */
  amount: number | null;
  memo: string;
  /** One of the expense account codes (5xxx range), best-effort. */
  suggestedAccountCode: string | null;
}

const DEFAULT_MEMO = "هزینهٔ استخراج‌شده از تصویر پیوست — پیش از تأیید بررسی شود";
const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
const ACCOUNT_CODE_RE = /^5\d{3}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses the receipt-extraction provider reply into structured fields.
 * Tolerates a ```json fence around the object (some models add one despite
 * being asked for raw JSON) and never throws — an unparseable or
 * wrong-shaped reply returns null so the caller can tell the user extraction
 * failed instead of proposing an expense with made-up numbers.
 */
export function parseReceiptExtractionReply(raw: string): ReceiptDraftFields | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unfenced = FENCE_RE.exec(trimmed)?.[1]?.trim() ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const amount = Number(obj.amount);
  const expenseDate = typeof obj.expenseDate === "string" ? obj.expenseDate.slice(0, 10) : "";

  return {
    vendor: typeof obj.vendor === "string" && obj.vendor.trim() ? obj.vendor.trim().slice(0, 200) : null,
    expenseDate: ISO_DATE_RE.test(expenseDate) ? expenseDate : null,
    amount: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null,
    memo: typeof obj.memo === "string" && obj.memo.trim() ? obj.memo.trim().slice(0, 300) : DEFAULT_MEMO,
    suggestedAccountCode:
      typeof obj.suggestedAccountCode === "string" && ACCOUNT_CODE_RE.test(obj.suggestedAccountCode)
        ? obj.suggestedAccountCode
        : null,
  };
}

/** System prompt for the isolated, single-purpose extraction call. */
export const RECEIPT_EXTRACTION_SYSTEM_PROMPT =
  "تو یک استخراج‌کنندهٔ اطلاعات فاکتور/رسید هستی. فقط یک شیء JSON معتبر و خام برگردان، بدون توضیح یا متن اضافه:" +
  ' {"vendor": string|null, "expenseDate": string|null (YYYY-MM-DD میلادی), "amount": number|null (مبلغ کل به ریال، عدد صحیح),' +
  ' "memo": string (توضیح کوتاه فارسی), "suggestedAccountCode": string|null (یکی از این کدهای هزینه در صورت تناسب: ' +
  "5100 بهای تمام‌شده مواد، 5150 ضایعات، 5160 کسری/مغایرت شمارش، 5170 کاهش ارزش موجودی، 5200 حقوق و دستمزد، " +
  '5300 اجاره، 5400 آب/برق/گاز، 5500 ملزومات مصرفی، 5600 بازاریابی، 5900 سایر هزینه‌ها)}. ' +
  "اگر مقداری از تصویر قابل تشخیص نیست، null بگذار؛ هرگز عدد یا تاریخ حدسی جعل نکن.";

/** User-facing instruction paired with the image content part. */
export const RECEIPT_EXTRACTION_USER_PROMPT =
  "اطلاعات این فاکتور/رسید را دقیقاً به‌صورت همان قالب JSON که در دستورالعمل سیستم آمده استخراج کن.";
