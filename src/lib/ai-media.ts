/**
 * Pure half of the media library's two AI abilities (migration 0149):
 *
 *   1. **Auto-tagging** — one vision call over an uploaded image proposes a
 *      category and tags. The proposal lands in `media_assets.ai_labels` with
 *      `ai_status = 'pending_review'`; nothing is applied until the operator
 *      confirms — the same "AI proposes, human confirms" rule as the visual
 *      stock counter's profiles.
 *
 *   2. **The product-image refine prompt** — the instruction handed to the
 *      provider's image-edit endpoint to produce the standard website product
 *      shot: pure white background, subject centered, consistent margins.
 *
 * Same split as `ai-inventory-vision.ts`: prompts and the tolerance around
 * the model's reply live here (unit-tested, no network); the provider call is
 * in `ai-media-service.ts`. A reply that cannot be parsed becomes null so the
 * caller says "failed" instead of inventing labels.
 */

export interface MediaLabelReply {
  /** Proposed category — one short Persian noun phrase, or null. */
  category: string | null;
  /** Proposed tags — cleaned, deduplicated, capped. */
  tags: string[];
  /** Short Persian description the operator sees beside the proposal. */
  description: string;
}

export const MEDIA_LABEL_SYSTEM_PROMPT =
  "تو دستیار سازمان‌دهی کتابخانهٔ رسانهٔ یک کسب‌وکار هستی. تصویر داده‌شده را ببین و برچسب‌های پیشنهادی بده. " +
  "فقط یک شیء JSON معتبر و خام برگردان، بدون توضیح یا متن اضافه: " +
  '{"category": "یک دسته‌بندی کوتاه فارسی (مثل «غذا و نوشیدنی»، «محصول»، «فضای داخلی»، «لوگو و برند»، «سند») یا null", ' +
  '"tags": ["حداکثر ۸ برچسب کوتاه فارسی دربارهٔ آنچه واقعاً در تصویر است"], ' +
  '"description": "یک جملهٔ کوتاه فارسی دربارهٔ تصویر"}. ' +
  "برچسب حدسی نساز؛ فقط چیزهایی را نام ببر که واقعاً در تصویر دیده می‌شوند.";

export function mediaLabelUserPrompt(fileName: string): string {
  return `نام فایل: «${fileName}». این تصویر را برچسب‌گذاری کن و همان الگوی JSON سیستم را برگردان.`;
}

const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 60;
const MAX_CATEGORY_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;

/** Parses (and clamps) the model's labelling reply; null for anything unparseable. */
export function parseMediaLabelReply(raw: string): MediaLabelReply | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const unfenced = FENCE_RE.exec(trimmed)?.[1].trim() ?? trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const category =
    typeof obj.category === "string" && obj.category.trim()
      ? obj.category.trim().slice(0, MAX_CATEGORY_LENGTH)
      : null;

  const tags: string[] = [];
  if (Array.isArray(obj.tags)) {
    const seen = new Set<string>();
    for (const raw of obj.tags) {
      if (typeof raw !== "string") continue;
      const tag = raw.trim().slice(0, MAX_TAG_LENGTH);
      if (!tag || seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
      if (tags.length >= MAX_TAGS) break;
    }
  }
  // A proposal with neither a category nor a single tag proposes nothing.
  if (!category && tags.length === 0) return null;

  const description =
    typeof obj.description === "string" && obj.description.trim()
      ? obj.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
      : "";

  return { category, tags, description };
}

/**
 * The instruction handed to the provider's image-edit endpoint for the
 * standard website product shot. In English on purpose: image-edit models are
 * instruction-following in English far more reliably than in Persian, and the
 * text is never shown to the user.
 */
export const MEDIA_ENHANCE_PROMPT =
  "Isolate the main product in this photo and produce a clean e-commerce product image: " +
  "pure white background (#FFFFFF), the product perfectly centered both horizontally and vertically, " +
  "consistent margins of about 8% on every side, upright and straightened alignment, soft natural shadow " +
  "directly under the product, color-accurate, no props, no text, no watermark, square 1:1 canvas.";

/** `{baseUrl}/images/edits` — the OpenAI-compatible image-edit endpoint. */
export function imageEditsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/images/edits`;
}

/**
 * Extracts the edited image from an OpenAI-compatible images response:
 * `{ data: [{ b64_json }] }` or `{ data: [{ url }] }`. Returns null when the
 * shape is anything else — the caller reports failure rather than storing a
 * mystery payload.
 */
export function parseImageEditReply(payload: unknown): { b64: string } | { url: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const first = data[0] as Record<string, unknown>;
  if (typeof first.b64_json === "string" && first.b64_json) return { b64: first.b64_json };
  if (typeof first.url === "string" && /^https?:\/\//.test(first.url)) return { url: first.url };
  return null;
}
