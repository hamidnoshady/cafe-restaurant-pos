/**
 * Pure half of AI tagging/counting for the visual stock counter: the prompts,
 * and the parser for the model's reply. No provider call, no DB — the same
 * split as `ai-receipt.ts`/`ai-invoice-ocr.ts`, for the same reason: the
 * prompts and the tolerance around the model's answer are the part worth
 * unit-testing, and the part a wrong guess in must never fabricate.
 *
 * What the model is asked for, and why:
 *
 *   * `count` — how many units of the named item are in the photo. The
 *     classical engine (src/lib/vision/) counts by color signature or circle
 *     geometry; the model counts by *understanding* the scene, which covers
 *     exactly the photos the engine can't: mixed shelves, occlusion, items
 *     with no visual profile yet.
 *   * `box` — the 0..1 rectangle of ONE exemplar unit, so a single AI call
 *     can also seed a visual profile (source 'ai') that makes future counts
 *     free and offline. The box is normalized so it survives the client's
 *     re-scaling.
 *   * `confidence` — the model's own self-assessment, displayed next to the
 *     count and stored on the evidence row; a low confidence is a hint to
 *     the operator to look, not a blocked action. The operator confirms
 *     everything either way.
 *
 * The reply is clamped, never trusted: counts outside 0..9999, boxes outside
 * the frame, confidences outside 0..1 are all pulled into range, and an
 * unparseable reply becomes null so the caller says "failed" instead of
 * inventing a number.
 */

export interface VisionCountReply {
  count: number;
  confidence: number;
  /** Normalized 0..1 box of one exemplar unit, when the model provided one. */
  box: { x: number; y: number; w: number; h: number } | null;
  /** Short Persian note the operator sees under the count. */
  comment: string;
}

export const VISION_COUNT_SYSTEM_PROMPT =
  "تو شمارندهٔ هوشمند اقلام انبار یک کافه/رستوران هستی. تصویر داده‌شده را ببین و فقط تعداد «قلم مشخص‌شده» را بشمار. " +
  "فقط یک شیء JSON معتبر و خام برگردان، بدون توضیح یا متن اضافه: " +
  '{"count": عدد صحیح (تعداد همان قلم در تصویر), "confidence": عدد بین ۰ و ۱ (اطمینان خودت), ' +
  '"box": {"x": عدد ۰ تا ۱, "y": عدد ۰ تا ۱, "w": عدد ۰ تا ۱, "h": عدد ۰ تا ۱} یا null ' +
  "(کادر دقیقاً یک نمونهٔ سالم از آن قلم، x و y گوشهٔ بالا-چپ), " +
  '"comment": "یادداشت کوتاه فارسی"}. ' +
  "اگر هیچ نمونه‌ای از آن قلم در تصویر نیست، count را ۰ بده. هرگز عدد حدسی نساز؛ اگر شمارش ممکن نیست، count را null بده و در comment توضیح بده.";

export function visionCountUserPrompt(itemName: string, unit: string): string {
  return (
    `قلم مورد نظر: «${itemName}» (واحد شمارش: ${unit}). ` +
    "تعداد این قلم را در تصویر بشمار، کادر یک نمونهٔ سالم را بده و همان الگوی JSON سیستم را برگردان."
  );
}

const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Parses (and clamps) the model's reply; null for anything unparseable. */
export function parseVisionCountReply(raw: string): VisionCountReply | null {
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

  const rawCount = obj.count;
  if (rawCount === null) return null;
  const count = Number(rawCount);
  if (!Number.isFinite(count)) return null;

  const confidence = Number(obj.confidence);
  const comment =
    typeof obj.comment === "string" && obj.comment.trim() ? obj.comment.trim().slice(0, 200) : "";

  let box: VisionCountReply["box"] = null;
  if (obj.box && typeof obj.box === "object") {
    const b = obj.box as Record<string, unknown>;
    const x = Number(b.x);
    const y = Number(b.y);
    const w = Number(b.w);
    const h = Number(b.h);
    if ([x, y, w, h].every((n) => Number.isFinite(n))) {
      box = {
        x: clamp(x, 0, 1),
        y: clamp(y, 0, 1),
        w: clamp(w, 0, 1),
        h: clamp(h, 0, 1),
      };
    }
  }

  return {
    count: Math.round(clamp(count, 0, 9999)),
    confidence: clamp(Number.isFinite(confidence) ? confidence : 0.5, 0, 1),
    box,
    comment,
  };
}
