/**
 * DB-free provider half of AI tagging/counting for the visual stock counter —
 * a single vision call that counts the named item in a photo and proposes the
 * box of one exemplar unit. Structured after `ai-invoice-ocr-service.ts`
 * (same provider contract, same timeout, same usage/cost accounting), with
 * the item catalogue lookup removed: the client already knows which item it
 * is counting, because the operator picked it (or scanned its barcode) in the
 * count screen. The image never leaves this request.
 */

import { chatCompletionsUrl, type AiConfig } from "./ai";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";
import { parseResponseCostHeader } from "./ai-gateway";
import {
  VISION_COUNT_SYSTEM_PROMPT,
  parseVisionCountReply,
  visionCountUserPrompt,
  type VisionCountReply,
} from "./ai-inventory-vision";

const REQUEST_TIMEOUT_MS = 90_000;

export class InventoryVisionError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "InventoryVisionError";
  }
}

type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string | ProviderContentPart[];
}

export interface InventoryVisionResult extends VisionCountReply {
  usage: AiTokenUsage;
  /** The gateway's own cost figure for the vision call (USD), when reported. */
  costUsd: number | null;
}

function providerHeaders(config: AiConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    // A gateway deployment authenticates with the branch/business's virtual
    // key when provisioned; every other deployment sends the platform key.
    Authorization: `Bearer ${config.gateway?.authKey || config.apiKey}`,
  };
}

function fallbackUsage(messages: ProviderMessage[], content: string): AiTokenUsage {
  return {
    inputTokens: estimateTokens(JSON.stringify(messages)),
    outputTokens: estimateTokens(content),
  };
}

/**
 * One metered vision turn: count the named item in the image, propose the
 * exemplar box. Throws InventoryVisionError on provider failures; an
 * unparseable reply is `vision_reply_invalid`, surfaced as a Persian message
 * rather than a fabricated count.
 */
export async function runInventoryVisionCount(input: {
  config: AiConfig;
  dataUrl: string;
  itemName: string;
  unit: string;
}): Promise<InventoryVisionResult> {
  const messages: ProviderMessage[] = [
    { role: "system", content: VISION_COUNT_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: visionCountUserPrompt(input.itemName, input.unit) },
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
      throw new InventoryVisionError("ai_timeout", "پاسخ سرویس هوش مصنوعی به‌موقع نرسید.");
    }
    throw new InventoryVisionError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new InventoryVisionError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    throw new InventoryVisionError("ai_provider", `سرویس هوش مصنوعی خطا داد (${res.status}).`, body);
  }

  const json = (await res.json()) as {
    choices?: { message?: ProviderMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new InventoryVisionError("ai_provider", "پاسخ سرویس هوش مصنوعی نامفهوم بود.");

  const text = typeof message.content === "string" ? message.content : "";
  const promptTokens = Number(json.usage?.prompt_tokens);
  const completionTokens = Number(json.usage?.completion_tokens);
  const usage =
    Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
      ? {
          inputTokens: Math.max(0, Math.floor(promptTokens)),
          outputTokens: Math.max(0, Math.floor(completionTokens)),
        }
      : fallbackUsage(messages, text);

  const reply = parseVisionCountReply(text);
  if (!reply) {
    throw new InventoryVisionError(
      "vision_reply_invalid",
      "شمارش هوشمند از روی این تصویر ممکن نشد؛ عددی حدسی جایگزین نمی‌شود.",
    );
  }

  return {
    ...reply,
    usage,
    costUsd: parseResponseCostHeader(res.headers.get("x-litellm-response-cost")),
  };
}
