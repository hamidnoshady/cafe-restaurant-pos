/**
 * Standalone (non-chat) receipt OCR for Accounting's direct "upload a photo of
 * a receipt" flow — `POST /api/ai/receipt-ocr`.
 *
 * This is a SIBLING of two things that already existed, not a replacement for
 * either:
 *   - `ai-receipt.ts` — the pure prompt/parser pair
 *     (`RECEIPT_EXTRACTION_SYSTEM_PROMPT`/`parseReceiptExtractionReply`) the
 *     AI Chat assistant's `draft_expense_from_receipt` tool already uses
 *     (`ai-service.ts`'s private `extractReceiptDraft`). Both callers share
 *     the exact same prompt and parser — there is exactly one definition of
 *     "what a receipt-extraction JSON reply looks like" in this codebase, not
 *     two independently-drifting ones.
 *   - `ai-invoice-ocr-service.ts` — the sibling supplier-invoice OCR service,
 *     whose `callVision`/error-mapping shape this module deliberately mirrors
 *     (same timeout, same header/auth handling, same ai_auth/ai_timeout/
 *     ai_network/ai_provider error codes) so every standalone AI-vision route
 *     in this app fails the same way rather than each inventing its own.
 *
 * What's actually new here: unlike both `ai-service.ts`'s chat-turn call and
 * the standalone invoice-ocr route ("the image is a one-shot data URL — never
 * persisted"), the route built on top of this module DOES persist the
 * receipt photo into the canonical Media Library after a successful
 * extraction — closing the "OCR inputs" gap named in MEDIA_LIBRARY_REPORT.md
 * Section V. This module itself stays storage-agnostic (no `media-service.ts`
 * import) — persistence is the route's job, exactly like `runMediaEnhance`
 * only returns bytes and lets its route call `storeMediaAsset`.
 */

import { chatCompletionsUrl, type AiConfig } from "./ai";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";
import { parseResponseCostHeader } from "./ai-gateway";
import {
  RECEIPT_EXTRACTION_SYSTEM_PROMPT,
  RECEIPT_EXTRACTION_USER_PROMPT,
  parseReceiptExtractionReply,
  type ReceiptDraftFields,
} from "./ai-receipt";

const REQUEST_TIMEOUT_MS = 60_000;

export class ReceiptOcrError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "ReceiptOcrError";
  }
}

type ProviderContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string | ProviderContentPart[];
}

function providerHeaders(config: AiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // Phase 37 & 39 — a gateway deployment authenticates with the calling
    // business's virtual key when one has been provisioned; every other
    // deployment sends the platform key. Same rule as ai-invoice-ocr-service.
    Authorization: `Bearer ${config.gateway?.authKey || config.apiKey}`,
  };
}

function textOf(content: ProviderMessage["content"]): string {
  return typeof content === "string" ? content : "";
}

function fallbackUsage(messages: ProviderMessage[], content: string): AiTokenUsage {
  return {
    inputTokens: estimateTokens(JSON.stringify(messages)),
    outputTokens: estimateTokens(content),
  };
}

export interface ReceiptOcrResult {
  fields: ReceiptDraftFields;
  usage: AiTokenUsage;
  costUsd: number | null;
}

/**
 * One isolated, non-streaming, tool-less vision call. Throws `ReceiptOcrError`
 * on a provider/network/timeout failure or an unparseable reply — the caller
 * settles the wallet only when this resolves, never on a throw.
 */
export async function runReceiptOcr(input: { config: AiConfig; dataUrl: string }): Promise<ReceiptOcrResult> {
  const messages: ProviderMessage[] = [
    { role: "system", content: RECEIPT_EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: RECEIPT_EXTRACTION_USER_PROMPT },
        { type: "image_url", image_url: { url: input.dataUrl } },
      ],
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(input.config.baseUrl), {
      method: "POST",
      headers: providerHeaders(input.config),
      body: JSON.stringify({
        model: input.config.model,
        messages,
        temperature: Math.min(input.config.temperature, 0.2),
        max_tokens: Math.max(input.config.maxOutputTokens ?? 1000, 1024),
        ...(input.config.gateway?.body ?? {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new ReceiptOcrError("ai_timeout", "پاسخ سرویس هوش مصنوعی به‌موقع نرسید.");
    }
    throw new ReceiptOcrError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new ReceiptOcrError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    throw new ReceiptOcrError("ai_provider", `سرویس هوش مصنوعی خطا داد (${res.status}).`, body);
  }

  const json = (await res.json()) as {
    choices?: { message?: ProviderMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new ReceiptOcrError("ai_provider", "پاسخ سرویس هوش مصنوعی نامفهوم بود.");

  const text = textOf(message.content);
  const fields = parseReceiptExtractionReply(text);
  if (!fields) {
    throw new ReceiptOcrError(
      "extraction_failed",
      "استخراج اطلاعات از تصویر رسید ممکن نشد. تصویر واضح‌تری بگیرید یا مقادیر را دستی وارد کنید.",
    );
  }

  const promptTokens = Number(json.usage?.prompt_tokens);
  const completionTokens = Number(json.usage?.completion_tokens);
  const usage =
    Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
      ? { inputTokens: Math.max(0, Math.floor(promptTokens)), outputTokens: Math.max(0, Math.floor(completionTokens)) }
      : fallbackUsage(messages, text);

  return {
    fields,
    usage,
    costUsd: parseResponseCostHeader(res.headers.get("x-litellm-response-cost")),
  };
}
