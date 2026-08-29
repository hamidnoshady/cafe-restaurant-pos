/**
 * The agent loop: talk to the configured OpenAI-compatible provider, run the
 * read-only tools it asks for, and surface any mutation as a proposed action for
 * human confirmation. Nothing here mutates business data.
 */
import {
  buildSystemPrompt,
  chatCompletionsUrl,
  isKnownAction,
  KNOWLEDGE_TOOL_NAME,
  toolDefinitions,
  type ActionType,
  type AgentMode,
  type AiConfig,
  type ProposedAction,
  type PromptContext,
} from "./ai";
import { runReadTool, type FloorReadScope, type ToolResult } from "./ai-tools";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";
import { clampRetrievalLimit, formatRetrievalForPrompt, isRetrievalAvailable, retrieveKnowledge } from "./ai-rag";
import { embedOne, isEmbeddingAvailable } from "./ai-embeddings";
import {
  parseReceiptExtractionReply,
  RECEIPT_EXTRACTION_SYSTEM_PROMPT,
  RECEIPT_EXTRACTION_USER_PROMPT,
  type ReceiptDraftFields,
} from "./ai-receipt";

export type { ProposedAction };

export interface AgentReply {
  content: string;
  proposedAction: ProposedAction | null;
  usage: AiTokenUsage;
  /**
   * Phase 36 Wave 7 — every tool this turn invoked, with the date range it was
   * given, so the caller can build the semantic cache's tool signature and
   * decide whether the turn was read-only. Empty for a turn that answered
   * without tools.
   */
  toolCalls: AgentToolCallTrace[];
}

export interface AgentToolCallTrace {
  name: string;
  /** Inclusive business-date range the call read, when the tool took one. */
  dateFrom?: string;
  dateTo?: string;
}

interface ProviderToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A multimodal user-message content part (Wave 5, issue #145). Only ever used
 * for the isolated receipt-extraction call below — the main conversation
 * loop stays plain-text, so an attached image is never resent on every tool
 * round.
 */
type ProviderContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ProviderContentPart[] | null;
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

interface ProviderStreamCallbacks {
  onDelta?: (content: string) => void;
  onToolCalls?: () => void;
}

interface ProviderStreamDelta {
  content?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    type?: "function";
    function?: { name?: string; arguments?: string };
  }[];
}

interface ProviderStreamChunk {
  choices?: { delta?: ProviderStreamDelta }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function fallbackUsage(messages: ProviderMessage[], content: string): AiTokenUsage {
  return {
    // Some compatible gateways omit usage. Charge a documented conservative
    // fallback rather than letting metered calls bypass the ledger altogether.
    inputTokens: estimateTokens(JSON.stringify(messages)),
    outputTokens: estimateTokens(content),
  };
}

function providerUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  fallback: AiTokenUsage,
): AiTokenUsage {
  const promptTokens = Number(usage?.prompt_tokens);
  const completionTokens = Number(usage?.completion_tokens);
  return Number.isFinite(promptTokens) && Number.isFinite(completionTokens)
    ? {
        inputTokens: Math.max(0, Math.floor(promptTokens)),
        outputTokens: Math.max(0, Math.floor(completionTokens)),
      }
    : fallback;
}

/**
 * Reads one OpenAI-compatible SSE response. Tool-call fragments are reassembled
 * before the normal agent loop sees them; visible text is forwarded immediately
 * so the dashboard can render a genuine streamed answer.
 */
async function readStreamingProviderResponse(
  response: Response,
  messages: ProviderMessage[],
  callbacks: ProviderStreamCallbacks,
): Promise<{ message: ProviderMessage; usage: AiTokenUsage }> {
  if (!response.body) throw new AiError("ai_provider", "پاسخ جریانی سرویس هوش مصنوعی نامعتبر بود.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ProviderToolCall>();
  let content = "";
  let buffer = "";
  let sawToolCalls = false;
  let providerReportedUsage: ProviderStreamChunk["usage"];

  function consumeData(raw: string) {
    if (!raw || raw === "[DONE]") return;
    let chunk: ProviderStreamChunk;
    try {
      chunk = JSON.parse(raw) as ProviderStreamChunk;
    } catch {
      return;
    }
    if (chunk.usage) providerReportedUsage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;

    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      callbacks.onDelta?.(delta.content);
    }

    if (!delta.tool_calls?.length) return;
    if (!sawToolCalls) {
      sawToolCalls = true;
      // A provider normally emits no natural-language content in a tool turn.
      // If one does, the client clears the provisional text before the next,
      // final response begins.
      callbacks.onToolCalls?.();
    }
    for (const part of delta.tool_calls) {
      const index = Number.isInteger(part.index) ? part.index! : 0;
      const previous = toolCalls.get(index) ?? {
        id: part.id ?? `stream-tool-${index}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (part.id) previous.id = part.id;
      if (part.function?.name) previous.function.name = part.function.name;
      if (part.function?.arguments) previous.function.arguments += part.function.arguments;
      toolCalls.set(index, previous);
    }
  }

  function consumeLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    consumeData(trimmed.slice(5).trim());
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
  } finally {
    reader.releaseLock();
  }

  const assembledToolCalls = [...toolCalls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
  const message: ProviderMessage = {
    role: "assistant",
    content: content || null,
    ...(assembledToolCalls.length > 0 ? { tool_calls: assembledToolCalls } : {}),
  };
  return {
    message,
    usage: providerUsage(providerReportedUsage, fallbackUsage(messages, content)),
  };
}

async function callProvider(
  config: AiConfig,
  messages: ProviderMessage[],
  tools: ReturnType<typeof toolDefinitions>,
  stream?: ProviderStreamCallbacks,
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
      stream: Boolean(stream),
    };
    if (stream) {
      // OpenAI-compatible APIs include final usage in the terminal stream
      // chunk when this option is supported; a conservative fallback remains
      // in place for gateways that omit it.
      body.stream_options = { include_usage: true };
    }
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
    // Some OpenAI-compatible gateways accept streaming but not the optional
    // usage trailer. Retry the same non-mutating provider request once without
    // it; the documented conservative usage fallback still protects billing.
    if (stream && res.status === 400) {
      const fallbackBody = { ...body };
      delete fallbackBody.stream_options;
      res = await fetch(chatCompletionsUrl(config.baseUrl), {
        method: "POST",
        headers: providerHeaders(config),
        body: JSON.stringify(fallbackBody),
        signal: controller.signal,
      });
    }
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

  if (stream && res.headers.get("content-type")?.includes("text/event-stream")) {
    return readStreamingProviderResponse(res, messages, stream);
  }

  const json = (await res.json()) as {
    choices?: { message?: ProviderMessage }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  if (!message) throw new AiError("ai_provider", "پاسخ سرویس هوش مصنوعی نامفهوم بود.");

  return {
    message,
    usage: providerUsage(json.usage, fallbackUsage(messages, textOf(message.content))),
  };
}

/** The assistant's own replies are always plain text; only a user turn ever carries multimodal parts. */
function textOf(content: ProviderMessage["content"]): string {
  return typeof content === "string" ? content : "";
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
 * A receipt/invoice image attached to one turn only (Wave 5, issue #145). The
 * data URL is never persisted anywhere — not to the conversation transcript,
 * not to any table or object storage — it is used for exactly one isolated
 * provider call and then discarded.
 */
export interface ChatAttachment {
  dataUrl: string;
}

interface ReceiptExtractionResult {
  fields: ReceiptDraftFields | null;
  usage: AiTokenUsage;
}

/**
 * One isolated, non-streaming, tool-less provider call that asks the same
 * configured platform provider (both defaults are vision-capable models) to
 * read a receipt image and return structured JSON. Deliberately its own
 * request rather than folding the image into the main conversation loop —
 * that would resend the image bytes on every later tool round.
 */
async function extractReceiptDraft(config: AiConfig, dataUrl: string): Promise<ReceiptExtractionResult> {
  const convo: ProviderMessage[] = [
    { role: "system", content: RECEIPT_EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: RECEIPT_EXTRACTION_USER_PROMPT },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  try {
    const result = await callProvider(config, convo, []);
    return { fields: parseReceiptExtractionReply(textOf(result.message.content)), usage: result.usage };
  } catch {
    return { fields: null, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

/** Both halves of Wave 6 availability, cached per process; never throws. */
async function isRetrievalEnabledForTurn(config: AiConfig): Promise<boolean> {
  try {
    return (await isRetrievalAvailable()) && (await isEmbeddingAvailable(config));
  } catch {
    return false;
  }
}

/**
 * Phase 36 Wave 6 — the `search_business_knowledge` executor. Embeds the
 * question over the shared platform connection (its tokens are metered into
 * the same turn, exit criterion 5), retrieves the nearest knowledge rows, and
 * hands the model prose whose every line names its source. Any failure —
 * provider, dimensions, SQL — is a missing hint, never a failed answer.
 */
async function runKnowledgeSearch(
  config: AiConfig,
  businessId: string,
  args: Record<string, unknown>,
  messages: InboundMessage[],
  usage: AiTokenUsage,
): Promise<ToolResult> {
  const fallbackQuestion = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const query = typeof args.query === "string" && args.query.trim() ? args.query : fallbackQuestion;
  if (!query.trim()) {
    return { ok: false, data: { error: "عبارت جست‌وجو خالی است." } };
  }
  try {
    const embedded = await embedOne(config, query);
    usage.inputTokens += embedded.inputTokens;
    const limit = clampRetrievalLimit(typeof args.limit === "number" ? args.limit : undefined);
    const results = await retrieveKnowledge(businessId, embedded.vector, { limit });
    if (results.length === 0) {
      return {
        ok: true,
        data: { results: [], note: "چیزی نزدیک این عبارت در دانش ثبت‌شدهٔ کسب‌وکار پیدا نشد." },
      };
    }
    return { ok: true, data: { count: results.length, knowledge: formatRetrievalForPrompt(results) } };
  } catch {
    return { ok: false, data: { error: "جست‌وجوی دانش کسب‌وکار در دسترس نیست." } };
  }
}

/** Wave 7 — the signature-relevant shape of one tool call: name + date range. */
function traceOf(name: string, args: Record<string, unknown>): AgentToolCallTrace {
  const trace: AgentToolCallTrace = { name };
  if (typeof args.dateFrom === "string") trace.dateFrom = args.dateFrom;
  if (typeof args.dateTo === "string") trace.dateTo = args.dateTo;
  return trace;
}

/**
 * Run one user turn to completion: resolve any read-tool calls server-side, and
 * stop as soon as the model proposes an action (returned for confirmation) or
 * produces a plain text answer.
 */export async function runAgentTurn(opts: {
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
  /** Optional callbacks turn the provider response into a live UI stream. */
  stream?: ProviderStreamCallbacks;
  promptContext: PromptContext;
  messages: InboundMessage[];
  /** Wave 5 (issue #145) — a receipt/invoice image attached to this turn only. */
  attachment?: ChatAttachment;
  /**
   * Wave 5 (issue #145) — the composer's "allow action in this message"
   * toggle. Only drops propose_action from this turn's own tool list; no
   * change to the confirm-before-apply architecture itself.
   */
  allowActions?: boolean;
  /**
   * Phase 31 — restricts which action types this turn may propose. Narrows the
   * tool schema the model sees AND is re-checked against the returned proposal,
   * so a hand-crafted response naming another action is refused rather than
   * treated as executable.
   */
  actionTypes?: ActionType[];
}): Promise<AgentReply> {
  const { config, mode, businessId, floorScope, promptContext, messages, attachment } = opts;
  const allowActions = opts.allowActions ?? true;
  const hasAttachment = Boolean(attachment);

  // Phase 36 Wave 6 — the retrieval tool is declared only when the whole chain
  // can actually serve it: pgvector + the 0113 table (isRetrievalAvailable)
  // and a platform connection that answers /embeddings. Both probes cache per
  // process, and neither ever throws — a probe that fails means "off", and off
  // is exactly the pre-wave behaviour. Desktop installs keep the assistant.
  const retrievalReady =
    mode === "dashboard" && Boolean(businessId) && (await isRetrievalEnabledForTurn(config));

  const tools = toolDefinitions(mode, { hasAttachment, actionTypes: opts.actionTypes, retrieval: retrievalReady }).filter(
    (tool) => allowActions || tool.function.name !== "propose_action",
  );
  const allowedActionTypes = opts.actionTypes ? new Set<string>(opts.actionTypes) : null;
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
  const toolTrace: AgentToolCallTrace[] = [];

  const convo: ProviderMessage[] = [
    { role: "system", content: buildSystemPrompt({ ...promptContext, hasAttachment, retrieval: retrievalReady }) },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callProvider(config, convo, tools, opts.stream);
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    const message = result.message;
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return {
        content: textOf(message.content).trim() || "متوجه نشدم؛ لطفاً دوباره بپرسید.",
        proposedAction: null,
        usage,
        toolCalls: toolTrace,
      };
    }

    // A proposed action ends the turn immediately — we never auto-execute it.
    const proposal = canPropose
      ? toolCalls.find((c) => c.function.name === "propose_action")
      : undefined;
    if (proposal) {
      const parsed = toProposedAction(parseArgs(proposal.function.arguments));
      const action = parsed && (!allowedActionTypes || allowedActionTypes.has(parsed.type)) ? parsed : null;
      const text = textOf(message.content).trim() || (action ? action.summary : "پیشنهاد آماده است.");
      return { content: text, proposedAction: action, usage, toolCalls: toolTrace };
    }

    // Otherwise every call must be a read tool — run them and feed results back.
    convo.push({ role: "assistant", content: textOf(message.content), tool_calls: toolCalls });
    for (const call of toolCalls) {
      let result: ToolResult;
      const callArgs = parseArgs(call.function.arguments);
      if (call.function.name === "draft_expense_from_receipt" && allowedReadToolNames.has(call.function.name)) {
        if (!attachment) {
          result = { ok: false, data: { error: "پیوستی برای این پیام وجود ندارد." } };
        } else {
          const extraction = await extractReceiptDraft(config, attachment.dataUrl);
          usage.inputTokens += extraction.usage.inputTokens;
          usage.outputTokens += extraction.usage.outputTokens;
          result = extraction.fields
            ? {
                ok: true,
                data: {
                  ...extraction.fields,
                  note: "این یک استخراج خودکار و تخمینی است؛ پیش از تأیید نهایی مقادیر را با کاربر بررسی کن.",
                },
              }
            : { ok: false, data: { error: "استخراج اطلاعات از تصویر پیوست ممکن نشد؛ می‌توانی مقادیر را از کاربر بپرسی." } };
        }
      } else if (
        call.function.name === KNOWLEDGE_TOOL_NAME &&
        allowedReadToolNames.has(call.function.name) &&
        retrievalReady &&
        businessId
      ) {
        result = await runKnowledgeSearch(config, businessId, callArgs, messages, usage);
      } else if (allowedReadToolNames.has(call.function.name) && toolRunner) {
        result = await toolRunner(call.function.name, callArgs);
      } else {
        result = { ok: false, data: { error: `ابزار ناشناخته: ${call.function.name}` } };
      }
      if (allowedReadToolNames.has(call.function.name)) {
        toolTrace.push(traceOf(call.function.name, callArgs));
      }
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
    toolCalls: toolTrace,
  };
}
