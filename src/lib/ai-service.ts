/**
 * The agent loop: talk to the configured OpenAI-compatible provider, run the
 * read-only tools it asks for, and surface any mutation as a proposed action for
 * human confirmation. Nothing here mutates business data.
 */
import {
  buildSystemPrompt,
  chatCompletionsUrl,
  isKnownAction,
  toolDefinitions,
  type AgentMode,
  type AiConfig,
  type ProposedAction,
  type PromptContext,
} from "./ai";
import { runReadTool, READ_TOOL_NAMES } from "./ai-tools";

export type { ProposedAction };

export interface AgentReply {
  content: string;
  proposedAction: ProposedAction | null;
}

interface ProviderToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
}

export interface InboundMessage {
  role: "user" | "assistant";
  content: string;
}

const MAX_TOOL_ROUNDS = 6;
const REQUEST_TIMEOUT_MS = 60_000;

function providerHeaders(config: AiConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  };
  if (config.provider === "openrouter") {
    // Optional attribution headers OpenRouter recommends.
    headers["HTTP-Referer"] = process.env.APP_URL ?? "https://cafe-pos.local";
    headers["X-Title"] = "Cafe/Restaurant POS";
  }
  return headers;
}

async function callProvider(
  config: AiConfig,
  messages: ProviderMessage[],
  tools: ReturnType<typeof toolDefinitions>,
): Promise<ProviderMessage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: providerHeaders(config),
      body: JSON.stringify({
        model: config.model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: config.temperature,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiError("ai_timeout", "پاسخ سرویس هوش مصنوعی به‌موقع نرسید.");
    }
    throw new AiError("ai_network", "اتصال به سرویس هوش مصنوعی برقرار نشد.");
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new AiError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", body);
    }
    throw new AiError("ai_provider", `سرویس هوش مصنوعی خطا داد (${res.status}).`, body);
  }

  const json = (await res.json()) as {
    choices?: { message?: ProviderMessage }[];
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new AiError("ai_provider", "پاسخ سرویس هوش مصنوعی نامفهوم بود.");
  return message;
}

export class AiError extends Error {
  constructor(
    public code: string,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "AiError";
  }
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toProposedAction(args: Record<string, unknown>): ProposedAction | null {
  if (!isKnownAction(args.type)) return null;
  const payload =
    args.payload && typeof args.payload === "object"
      ? (args.payload as Record<string, unknown>)
      : {};
  return {
    type: args.type,
    title: typeof args.title === "string" ? args.title : "پیشنهاد تغییر",
    summary: typeof args.summary === "string" ? args.summary : "",
    payload,
  };
}

/**
 * Run one user turn to completion: resolve any read-tool calls server-side, and
 * stop as soon as the model proposes an action (returned for confirmation) or
 * produces a plain text answer.
 */
export async function runAgentTurn(opts: {
  config: AiConfig;
  mode: AgentMode;
  businessId: string;
  promptContext: PromptContext;
  messages: InboundMessage[];
}): Promise<AgentReply> {
  const { config, mode, businessId, promptContext, messages } = opts;
  const tools = toolDefinitions(mode);

  const convo: ProviderMessage[] = [
    { role: "system", content: buildSystemPrompt(promptContext) },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await callProvider(config, convo, tools);
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return { content: message.content?.trim() || "متوجه نشدم؛ لطفاً دوباره بپرسید.", proposedAction: null };
    }

    // A proposed action ends the turn immediately — we never auto-execute it.
    const proposal = toolCalls.find((c) => c.function.name === "propose_action");
    if (proposal) {
      const action = toProposedAction(parseArgs(proposal.function.arguments));
      const text =
        message.content?.trim() || (action ? action.summary : "پیشنهاد آماده است.");
      return { content: text, proposedAction: action };
    }

    // Otherwise every call must be a read tool — run them and feed results back.
    convo.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });
    for (const call of toolCalls) {
      const result = READ_TOOL_NAMES.has(call.function.name)
        ? await runReadTool(call.function.name, parseArgs(call.function.arguments), businessId)
        : { ok: false, data: { error: `ابزار ناشناخته: ${call.function.name}` } };
      convo.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.data),
      });
    }
  }

  return {
    content: "برای پاسخ به این درخواست به مراحل زیادی نیاز بود. لطفاً سؤال را ساده‌تر بپرسید.",
    proposedAction: null,
  };
}
