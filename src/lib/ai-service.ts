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
import { runReadTool, type FloorReadScope, type ToolResult } from "./ai-tools";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";

export type { ProposedAction };

export interface AgentReply {
  content: string;
  proposedAction: ProposedAction | null;
  usage: AiTokenUsage;
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

/** Supplies data only for the tool names exposed by the active agent mode. */
export type ReadToolRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

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
): Promise<{ message: ProviderMessage; usage: AiTokenUsage }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    // Some OpenAI-compatible providers reject an explicit empty tools array.
    // Proactive Wave 4 digests deliberately have no tools, because their
    // tenant-scoped facts are collected before the provider is called.
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxOutputTokens,
      stream: false,
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    res = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: providerHeaders(config),
      body: JSON.stringify(body),
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
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new AiError("ai_provider", "پاسخ سرویس هوش مصنوعی نامفهوم بود.");

  const promptTokens = Number(json.usage?.prompt_tokens);
  const completionTokens = Number(json.usage?.completion_tokens);
  const usage: AiTokenUsage =
    Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
      ? {
          inputTokens: Math.max(0, Math.floor(promptTokens)),
          outputTokens: Math.max(0, Math.floor(completionTokens)),
        }
      : {
          // Some compatible gateways omit usage. Charge a documented
          // conservative fallback rather than letting metered calls bypass the
          // ledger altogether.
          inputTokens: estimateTokens(JSON.stringify(messages)),
          outputTokens: estimateTokens(message.content ?? ""),
        };

  return { message, usage };
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
  /** Tenant turns provide this. Platform support supplies executeReadTool instead. */
  businessId?: string;
  /** Present only for the cashier/waiter assistant; it constrains all floor reads. */
  floorScope?: FloorReadScope;
  /**
   * A separate read-tool realm can supply its own executor. It is deliberately
   * invoked only after the tool name is checked against toolDefinitions(mode).
   */
  executeReadTool?: ReadToolRunner;
  promptContext: PromptContext;
  messages: InboundMessage[];
}): Promise<AgentReply> {
  const { config, mode, businessId, floorScope, promptContext, messages } = opts;
  const tools = toolDefinitions(mode);
  const canPropose = tools.some((tool) => tool.function.name === "propose_action");
  const allowedReadToolNames = new Set(
    tools
      .map((tool) => tool.function.name)
      .filter((name) => name !== "propose_action"),
  );
  const toolRunner: ReadToolRunner | null =
    opts.executeReadTool ??
    (businessId ? (name, args) => runReadTool(name, args, businessId, floorScope) : null);
  const usage: AiTokenUsage = { inputTokens: 0, outputTokens: 0 };

  const convo: ProviderMessage[] = [
    { role: "system", content: buildSystemPrompt(promptContext) },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callProvider(config, convo, tools);
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    const message = result.message;
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return {
        content: message.content?.trim() || "متوجه نشدم؛ لطفاً دوباره بپرسید.",
        proposedAction: null,
        usage,
      };
    }

    // A proposed action ends the turn immediately — we never auto-execute it.
    const proposal = canPropose
      ? toolCalls.find((c) => c.function.name === "propose_action")
      : undefined;
    if (proposal) {
      const action = toProposedAction(parseArgs(proposal.function.arguments));
      const text =
        message.content?.trim() || (action ? action.summary : "پیشنهاد آماده است.");
      return { content: text, proposedAction: action, usage };
    }

    // Otherwise every call must be a read tool — run them and feed results back.
    convo.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });
    for (const call of toolCalls) {
      const result =
        allowedReadToolNames.has(call.function.name) && toolRunner
          ? await toolRunner(call.function.name, parseArgs(call.function.arguments))
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
    usage,
  };
}
