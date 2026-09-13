/**
 * DB-free provider half of the media library's AI abilities — structured
 * after `ai-inventory-vision-service.ts` (same provider contract, same
 * timeout, same usage/cost accounting):
 *
 *   • `runMediaLabelDetection` — one vision chat turn that proposes a
 *     category + tags for an uploaded image. The image never leaves this
 *     request; the proposal is stored as pending review, never applied.
 *
 *   • `runMediaEnhance` — one call to the provider's OpenAI-compatible
 *     `/images/edits` endpoint that turns a product photo into the standard
 *     website shot (white background, centered, aligned). Providers that do
 *     not expose an image-edit model answer 404/400, which surfaces to the
 *     operator as a clear Persian message rather than a hang.
 */
import { chatCompletionsUrl, type AiConfig } from "./ai";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";
import { parseResponseCostHeader } from "./ai-gateway";
import {
  imageEditsUrl,
  MEDIA_ENHANCE_PROMPT,
  MEDIA_LABEL_SYSTEM_PROMPT,
  mediaLabelUserPrompt,
  parseImageEditReply,
  parseMediaLabelReply,
  type MediaLabelReply,
} from "./ai-media";

const LABEL_TIMEOUT_MS = 60_000;
const ENHANCE_TIMEOUT_MS = 120_000;
/** An edited product shot larger than this is a provider bug, not an image. */
const MAX_ENHANCED_BYTES = 12 * 1024 * 1024;

export class MediaAiError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "MediaAiError";
  }
}

type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string | ProviderContentPart[];
}

function providerHeaders(config: AiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.gateway?.authKey || config.apiKey}`,
  };
}

export interface MediaLabelResult extends MediaLabelReply {
  usage: AiTokenUsage;
  costUsd: number | null;
}

/** One metered vision turn proposing category/tags for an image. */
export async function runMediaLabelDetection(input: {
  config: AiConfig;
  dataUrl: string;
  fileName: string;
}): Promise<MediaLabelResult> {
  const messages: ProviderMessage[] = [
    { role: "system", content: MEDIA_LABEL_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: mediaLabelUserPrompt(input.fileName) },
        { type: "image_url", image_url: { url: input.dataUrl } },
      ],
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LABEL_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(input.config.baseUrl), {
      method: "POST",
      headers: providerHeaders(input.config),
      body: JSON.stringify({
        model: input.config.model,
        messages,
        temperature: Math.min(input.config.temperature, 0.2),
        max_tokens: Math.max(input.config.maxOutputTokens ?? 1000, 512),
        ...(input.config.gateway?.body ?? {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new MediaAiError("ai_timeout", "پاسخ سرویس هوش مصنوعی به‌موقع نرسید.");
    }
    throw new MediaAiError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new MediaAiError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    throw new MediaAiError("ai_provider", `سرویس هوش مصنوعی خطا داد (${res.status}).`, body);
  }

  const payload = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const content = payload?.choices?.[0]?.message?.content ?? "";
  const reply = parseMediaLabelReply(content);
  if (!reply) {
    throw new MediaAiError("ai_reply_invalid", "پاسخ مدل قابل استفاده نبود؛ برچسبی پیشنهاد نشد.");
  }

  const usage: AiTokenUsage = payload?.usage
    ? {
        inputTokens: Math.max(0, Math.floor(payload.usage.prompt_tokens ?? 0)),
        outputTokens: Math.max(0, Math.floor(payload.usage.completion_tokens ?? 0)),
      }
    : { inputTokens: estimateTokens(JSON.stringify(messages)), outputTokens: estimateTokens(content) };

  return { ...reply, usage, costUsd: parseResponseCostHeader(res.headers.get("x-litellm-response-cost")) };
}

export interface MediaEnhanceResult {
  /** PNG bytes of the standard product shot. */
  bytes: Buffer;
  costUsd: number | null;
}

/**
 * One image-edit call: photo in, standard white-background product shot out.
 * `model` comes from the console config (platform_media_config.enhance_model).
 */
export async function runMediaEnhance(input: {
  config: AiConfig;
  model: string;
  imageBytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<MediaEnhanceResult> {
  const form = new FormData();
  form.set("model", input.model);
  form.set("prompt", MEDIA_ENHANCE_PROMPT);
  form.set(
    "image",
    new Blob([new Uint8Array(input.imageBytes)], { type: input.mimeType }),
    input.fileName,
  );

  const headers = providerHeaders(input.config);
  delete headers["Content-Type"]; // multipart boundary is fetch's to set

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENHANCE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(imageEditsUrl(input.config.baseUrl), {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new MediaAiError("ai_timeout", "پاسخ سرویس ویرایش تصویر به‌موقع نرسید.");
    }
    throw new MediaAiError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new MediaAiError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    if (res.status === 404 || res.status === 400) {
      throw new MediaAiError(
        "enhance_unsupported",
        "سرویس هوش مصنوعی فعلی از ویرایش تصویر پشتیبانی نمی‌کند.",
        body,
      );
    }
    throw new MediaAiError("ai_provider", `سرویس ویرایش تصویر خطا داد (${res.status}).`, body);
  }

  const costUsd = parseResponseCostHeader(res.headers.get("x-litellm-response-cost"));
  const payload = await res.json().catch(() => null);
  const parsed = parseImageEditReply(payload);
  if (!parsed) {
    throw new MediaAiError("ai_reply_invalid", "پاسخ سرویس ویرایش تصویر قابل استفاده نبود.");
  }

  let bytes: Buffer;
  if ("b64" in parsed) {
    bytes = Buffer.from(parsed.b64, "base64");
  } else {
    const dl = await fetch(parsed.url, { signal: AbortSignal.timeout(ENHANCE_TIMEOUT_MS) });
    if (!dl.ok) throw new MediaAiError("ai_provider", "دریافت تصویر ویرایش‌شده ناموفق بود.");
    bytes = Buffer.from(await dl.arrayBuffer());
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENHANCED_BYTES) {
    throw new MediaAiError("ai_reply_invalid", "تصویر ویرایش‌شده معتبر نبود.");
  }
  return { bytes, costUsd };
}
