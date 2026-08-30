/**
 * AI-backed supplier-invoice OCR for the purchases flow.
 *
 * Mirrors Wave 5's receipt/expense extraction (`ai-receipt.ts`) but returns
 * *line items* a manager can drop into a draft purchase: vendor, date, and a
 * list of {name, quantity, unit, lineTotalRial, barcode?}. Matching those
 * names against the branch's `inventory_items` / barcodes happens server-side
 * after extraction so the model never invents UUIDs.
 *
 * The image is a client-supplied data URL used for exactly one provider call
 * and is never written to any table or object storage — same storage decision
 * as the expense-receipt path.
 */

import { normalizeBarcode } from "./barcode";
import { toLatinDigits } from "./digits";
import {
  MAX_RECEIPT_IMAGE_BYTES,
  parseReceiptImageDataUrl,
  type ParsedReceiptImage,
} from "./ai-receipt";

export { MAX_RECEIPT_IMAGE_BYTES, parseReceiptImageDataUrl };
export type { ParsedReceiptImage };

const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One line the model extracted from the invoice image (pre-matching). */
export interface ExtractedInvoiceLine {
  /** Free-text name as printed on the invoice. */
  name: string;
  /** Quantity in the unit the invoice used (purchase unit when known). */
  quantity: string | null;
  /** Unit label as printed, e.g. "kg", "کیلو", "عدد". */
  unit: string | null;
  /** Line total in integer Rial. Null when unreadable. */
  lineTotalRial: number | null;
  /** Optional barcode / SKU printed on the line. */
  barcode: string | null;
  /** 0..1 confidence the model reported for this line; null when omitted. */
  confidence: number | null;
}

export interface ExtractedInvoice {
  vendor: string | null;
  /** ISO date (YYYY-MM-DD), best-effort. */
  invoiceDate: string | null;
  /** Invoice / reference number as printed. */
  invoiceNumber: string | null;
  /** Grand total in integer Rial, best-effort. */
  totalRial: number | null;
  note: string;
  lines: ExtractedInvoiceLine[];
  /** Raw OCR-ish text the model saw, for audit / debugging in the UI. */
  rawText: string | null;
}

const DEFAULT_NOTE = "استخراج‌شده از تصویر فاکتور — پیش از ثبت بررسی شود";

function asTrimmedString(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
}

function asPositiveRial(value: unknown): number | null {
  if (typeof value === "string") {
    const cleaned = toLatinDigits(value).replace(/[^\d.-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function asQuantityText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return String(value);
  }
  if (typeof value !== "string") return null;
  const cleaned = toLatinDigits(value).trim().replace(/,/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Keep the original cleaned text so "1.5" stays "1.5" rather than "1.500000".
  return cleaned.slice(0, 32);
}

function asConfidence(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 1) return null;
  return Math.round(n * 100) / 100;
}

function asIsoDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const iso = toLatinDigits(value).trim().slice(0, 10);
  if (!ISO_DATE_RE.test(iso)) return null;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/**
 * Parses the invoice-extraction provider reply into structured fields.
 * Tolerates a ```json fence and never throws — an unparseable reply returns
 * null so the caller can tell the user extraction failed instead of proposing
 * a purchase with made-up lines.
 */
export function parseInvoiceExtractionReply(raw: string): ExtractedInvoice | null {
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

  const rawLines = Array.isArray(obj.lines) ? obj.lines : [];
  const lines: ExtractedInvoiceLine[] = [];
  for (const entry of rawLines.slice(0, 80)) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = asTrimmedString(row.name, 200);
    if (!name) continue;
    const barcodeRaw = asTrimmedString(row.barcode ?? row.sku, 64);
    lines.push({
      name,
      quantity: asQuantityText(row.quantity ?? row.qty),
      unit: asTrimmedString(row.unit, 40),
      lineTotalRial: asPositiveRial(row.lineTotalRial ?? row.total ?? row.amount),
      barcode: barcodeRaw ? normalizeBarcode(barcodeRaw) || barcodeRaw : null,
      confidence: asConfidence(row.confidence),
    });
  }

  // An invoice with no readable lines is still useful for vendor/date/total,
  // but the purchases form needs lines — keep empty and let the UI say so.
  return {
    vendor: asTrimmedString(obj.vendor ?? obj.supplier, 200),
    invoiceDate: asIsoDate(obj.invoiceDate ?? obj.date ?? obj.expenseDate),
    invoiceNumber: asTrimmedString(obj.invoiceNumber ?? obj.number ?? obj.ref, 80),
    totalRial: asPositiveRial(obj.totalRial ?? obj.total ?? obj.amount),
    note:
      asTrimmedString(obj.note ?? obj.memo, 300) ??
      (obj.invoiceNumber
        ? `${DEFAULT_NOTE} — شماره ${String(obj.invoiceNumber).slice(0, 40)}`
        : DEFAULT_NOTE),
    lines,
    rawText: asTrimmedString(obj.rawText, 4000),
  };
}

/** System prompt for the isolated, single-purpose invoice extraction call. */
export const INVOICE_EXTRACTION_SYSTEM_PROMPT =
  "تو یک استخراج‌کنندهٔ فاکتور خرید تأمین‌کننده هستی. فقط یک شیء JSON معتبر و خام برگردان، بدون توضیح یا متن اضافه: " +
  '{"vendor": string|null, "invoiceDate": string|null (YYYY-MM-DD میلادی), "invoiceNumber": string|null, ' +
  '"totalRial": number|null (جمع کل به ریال، عدد صحیح), "note": string (یادداشت کوتاه فارسی), ' +
  '"rawText": string|null (متن خوانده‌شده از تصویر، اختیاری), ' +
  '"lines": Array<{ "name": string, "quantity": number|string|null, "unit": string|null, ' +
  '"lineTotalRial": number|null (مبلغ همان ردیف به ریال), "barcode": string|null, "confidence": number|null (۰ تا ۱) }>}. ' +
  "مبالغ را به ریال بنویس (اگر فاکتور تومان است ×۱۰). تاریخ را میلادی ISO بده حتی اگر فاکتور شمسی باشد. " +
  "اگر مقداری از تصویر قابل تشخیص نیست null بگذار؛ هرگز عدد، تاریخ یا نام کالا را حدس نزن. " +
  "فقط اقلامی را در lines بگذار که واقعاً روی فاکتور دیده می‌شوند.";

/** User-facing instruction paired with the image content part. */
export const INVOICE_EXTRACTION_USER_PROMPT =
  "اطلاعات این فاکتور خرید تأمین‌کننده را دقیقاً به‌صورت همان قالب JSON که در دستورالعمل سیستم آمده استخراج کن. اقلام، مقادیر و مبالغ را با دقت بخوان.";

/**
 * AI validation of an already-extracted invoice against catalogue matches.
 * Pure: given the extraction + match outcomes, produce a human-readable
 * review summary and a pass/warn/fail verdict the UI can gate on.
 */
export type InvoiceMatchStatus = "matched" | "ambiguous" | "unmatched";

export interface InvoiceLineMatchInput {
  name: string;
  quantity: string | null;
  unit: string | null;
  lineTotalRial: number | null;
  barcode: string | null;
  confidence: number | null;
  matchStatus: InvoiceMatchStatus;
  matchedItemName: string | null;
  /** How many catalogue candidates the barcode/name search returned. */
  candidateCount: number;
}

export interface InvoiceValidationResult {
  verdict: "pass" | "warn" | "fail";
  /** Short Persian summary for the review card. */
  summary: string;
  issues: string[];
  /** 0..1 overall confidence derived from line confidences + match rate. */
  overallConfidence: number;
}

export function validateExtractedInvoice(input: {
  extraction: ExtractedInvoice;
  lines: InvoiceLineMatchInput[];
  /** Sum of matched line totals, when available. */
  matchedLinesTotalRial: number | null;
}): InvoiceValidationResult {
  const issues: string[] = [];
  const { extraction, lines } = input;

  if (lines.length === 0) {
    issues.push("هیچ قلمی از تصویر فاکتور خوانده نشد.");
  }

  const matched = lines.filter((l) => l.matchStatus === "matched").length;
  const ambiguous = lines.filter((l) => l.matchStatus === "ambiguous").length;
  const unmatched = lines.filter((l) => l.matchStatus === "unmatched").length;

  if (unmatched > 0) {
    issues.push(`${unmatched} قلم به کالای انبار متصل نشد — باید دستی انتخاب شود.`);
  }
  if (ambiguous > 0) {
    issues.push(`${ambiguous} قلم چند کالای مشابه دارد — یکی را انتخاب کنید.`);
  }

  for (const line of lines) {
    if (!line.quantity) {
      issues.push(`مقدار «${line.name}» خوانده نشد.`);
    }
    if (line.lineTotalRial == null) {
      issues.push(`مبلغ «${line.name}» خوانده نشد.`);
    }
    if (line.confidence != null && line.confidence < 0.45) {
      issues.push(`اطمینان پایین برای «${line.name}» (${Math.round(line.confidence * 100)}٪).`);
    }
  }

  if (
    extraction.totalRial != null &&
    input.matchedLinesTotalRial != null &&
    input.matchedLinesTotalRial > 0
  ) {
    const delta = Math.abs(extraction.totalRial - input.matchedLinesTotalRial);
    const tolerance = Math.max(1000, Math.round(extraction.totalRial * 0.02));
    if (delta > tolerance) {
      issues.push(
        `جمع ردیف‌ها با جمع کل فاکتور هم‌خوان نیست (اختلاف ${delta.toLocaleString("en-US")} ریال).`,
      );
    }
  }

  if (!extraction.vendor) {
    issues.push("نام تأمین‌کننده از فاکتور خوانده نشد.");
  }
  if (!extraction.invoiceDate) {
    issues.push("تاریخ فاکتور خوانده نشد.");
  }

  const confidences = lines
    .map((l) => l.confidence)
    .filter((c): c is number => typeof c === "number");
  const avgConfidence =
    confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : lines.length === 0
        ? 0
        : 0.5;
  const matchRate = lines.length === 0 ? 0 : matched / lines.length;
  const overallConfidence = Math.round((avgConfidence * 0.6 + matchRate * 0.4) * 100) / 100;

  let verdict: InvoiceValidationResult["verdict"] = "pass";
  if (lines.length === 0 || matched === 0) {
    verdict = "fail";
  } else if (issues.length > 0 || overallConfidence < 0.7) {
    verdict = "warn";
  }

  const summary =
    verdict === "pass"
      ? `${matched} قلم با اطمینان بالا به انبار متصل شد.`
      : verdict === "warn"
        ? `${matched} از ${lines.length} قلم متصل شد؛ موارد نیازمند بررسی باقی مانده است.`
        : "استخراج فاکتور ناقص است و بدون اصلاح قابل ثبت نیست.";

  // Cap issue list so a 40-line invoice does not drown the card.
  return {
    verdict,
    summary,
    issues: issues.slice(0, 12),
    overallConfidence,
  };
}

/**
 * Fuzzy name score used when matching an OCR line to inventory items.
 * Pure and unit-tested — the service layer only supplies the candidate list.
 */
export function scoreNameMatch(query: string, candidate: string): number {
  const a = normalizeName(query);
  const b = normalizeName(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    return 0.72 + (shorter / longer) * 0.2;
  }
  // Token overlap (order-independent) for multi-word Persian names.
  const aTokens = new Set(a.split(" ").filter(Boolean));
  const bTokens = new Set(b.split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const t of aTokens) if (bTokens.has(t)) overlap += 1;
  const union = new Set([...aTokens, ...bTokens]).size;
  const jaccard = overlap / union;
  return jaccard >= 0.5 ? 0.4 + jaccard * 0.4 : jaccard * 0.5;
}

function normalizeName(value: string): string {
  return toLatinDigits(value)
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[‌‍]/g, "") // ZWNJ / ZWJ
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pick the best catalogue match for one extracted line. Prefer an exact
 * barcode hit; otherwise the highest name score above the threshold. Pure.
 */
export function pickBestInventoryMatch<T extends { id: string; name: string; code?: string | null }>(
  line: { name: string; barcode: string | null },
  candidates: T[],
  options: { nameThreshold?: number } = {},
): { status: InvoiceMatchStatus; item: T | null; score: number; candidates: T[] } {
  const threshold = options.nameThreshold ?? 0.55;
  if (line.barcode) {
    const code = normalizeBarcode(line.barcode);
    const byCode = candidates.filter((c) => c.code && normalizeBarcode(c.code) === code);
    if (byCode.length === 1) {
      return { status: "matched", item: byCode[0], score: 1, candidates: byCode };
    }
    if (byCode.length > 1) {
      return { status: "ambiguous", item: null, score: 1, candidates: byCode };
    }
  }

  const scored = candidates
    .map((c) => ({ item: c, score: scoreNameMatch(line.name, c.name) }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { status: "unmatched", item: null, score: 0, candidates: [] };
  }
  // Near-ties stay ambiguous so a human picks rather than a silent wrong match.
  const top = scored[0];
  const close = scored.filter((s) => top.score - s.score < 0.08);
  if (close.length > 1) {
    return {
      status: "ambiguous",
      item: null,
      score: top.score,
      candidates: close.map((c) => c.item),
    };
  }
  return {
    status: "matched",
    item: top.item,
    score: top.score,
    candidates: scored.slice(0, 5).map((s) => s.item),
  };
}
