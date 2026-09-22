/**
 * The agent loop: talk to the configured OpenAI-compatible provider, run the
 * read-only tools it asks for, and surface any mutation as a proposed action for
 * human confirmation. Nothing here mutates business data.
 */
import {
  ACTION_CATALOG,
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
import { validateInputRequest, type InputRequestSpec } from "./ai-input-protocol";
import { estimateTokens, type AiTokenUsage } from "./ai-billing";
import { parseProviderError, parseResponseCostHeader } from "./ai-gateway";
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
  /**
   * Phase E — a typed input request the model raised this turn (a choice, a
   * multi-choice or a form). Mutually exclusive with `proposedAction`: a turn
   * either asks the user for input or proposes a write, never both. Null when
   * the turn neither asked nor proposed.
   */
  inputRequest: InputRequestSpec | null;
  usage: AiTokenUsage;
  /**
   * Phase 38b — the gateway's own cost figure for this turn, summed across
   * every provider round (USD). Null whenever the responder did not report
   * one — a direct vendor, or a proxy with cost tracking off — which the
   * settlement reads as "price from the token rates instead", never as free.
   */
  costUsd: number | null;
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
  return {
    "Content-Type": "application/json",
    // Phase 37 — a gateway deployment authenticates the call with the calling
    // business's virtual key when one has been provisioned; every other
    // deployment sends the platform key.
    Authorization: `Bearer ${config.gateway?.authKey || config.apiKey}`,
  };
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

function responseCostUsd(response: Response): number | null {
  return parseResponseCostHeader(response.headers.get("x-litellm-response-cost"));
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
): Promise<ProviderResult> {
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
    costUsd: responseCostUsd(response),
  };
}

/** One completed provider round: its message, tokens, and any gateway cost. */
interface ProviderResult {
  message: ProviderMessage;
  usage: AiTokenUsage;
  costUsd: number | null;
}

async function callProvider(
  config: AiConfig,
  messages: ProviderMessage[],
  tools: ReturnType<typeof toolDefinitions>,
  stream?: ProviderStreamCallbacks,
): Promise<ProviderResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxOutputTokens,
      stream: Boolean(stream),
    };
    if (stream) {
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

    // If streaming returned 400, retry once without the optional stream_options
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
    const rawBody = await res.text().catch(() => "");
    const parsed = parseProviderError(res.status, rawBody);

    // Structured server-side error logging (never logs secret keys)
    console.error("ai provider error", {
      status: res.status,
      model: config.model,
      url: chatCompletionsUrl(config.baseUrl),
      authType: config.gateway?.authKey ? "virtual_key" : "master_key",
      errorType: parsed.type,
      errorCode: parsed.code,
      detail: parsed.sanitizedReason,
    });

    if (res.status === 401 || res.status === 403) {
      throw new AiError("ai_auth", "کلید سرویس هوش مصنوعی نامعتبر است.", parsed.sanitizedReason, res.status);
    }
    if (res.status === 404) {
      throw new AiError("ai_model_not_found", "مدل یا سرویس هوش مصنوعی در دسترس نیست.", parsed.sanitizedReason, res.status);
    }
    if (res.status === 429) {
      throw new AiError("ai_rate_limited", "سرویس هوش مصنوعی در حال حاضر پرکاربرد است؛ کمی بعد دوباره تلاش کنید.", parsed.sanitizedReason, res.status);
    }
    if (res.status === 400) {
      throw new AiError(
        "ai_invalid_request",
        "درخواست توسط سرویس هوش مصنوعی رد شد. مدیر پلتفرم می‌تواند جزئیات فنی را بررسی کند.",
        parsed.sanitizedReason,
        res.status,
      );
    }
    throw new AiError(
      "ai_provider",
      "سرویس هوش مصنوعی با خطا مواجه شد.",
      parsed.sanitizedReason,
      res.status,
    );
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
    costUsd: responseCostUsd(res),
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
    public status?: number,
  ) {
    super(message);
    this.name = "AiError";
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toProposedAction(args: Record<string, unknown>): ProposedAction | null {
  const type = args.type;
  if (!isKnownAction(type)) return null;
  const title = typeof args.title === "string" ? args.title.trim() : "";
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  const payload = args.payload && typeof args.payload === "object" && !Array.isArray(args.payload)
    ? (args.payload as Record<string, unknown>)
    : {};
  if (!title || !summary) return null;
  return { type, title, summary, payload };
}

function traceOf(name: string, args: Record<string, unknown>): AgentToolCallTrace {
  const dateFrom = typeof args.dateFrom === "string" ? args.dateFrom : undefined;
  const dateTo = typeof args.dateTo === "string" ? args.dateTo : undefined;
  return { name, ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}) };
}

/**
 * Isolated multimodal call for receipt/invoice extraction.
 * No tools, strict prompt, returns structured draft fields.
 */
async function extractReceiptDraft(
  config: AiConfig,
  imageUrl: string,
): Promise<{ fields: ReceiptDraftFields | null; usage: AiTokenUsage; costUsd: number | null }> {
  const messages: ProviderMessage[] = [
    { role: "system", content: RECEIPT_EXTRACTION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: RECEIPT_EXTRACTION_USER_PROMPT },
        { type: "image_url", image_url: { url: imageUrl } },
      ],
    },
  ];

  const result = await callProvider(config, messages, []);
  const replyText = textOf(result.message.content);
  return {
    fields: parseReceiptExtractionReply(replyText),
    usage: result.usage,
    costUsd: result.costUsd,
  };
}

/**
 * Semantic knowledge search tool execution during an agent turn.
 */
async function runKnowledgeSearch(
  config: AiConfig,
  businessId: string,
  callArgs: Record<string, unknown>,
  messages: ProviderMessage[],
  usage: AiTokenUsage,
): Promise<ToolResult> {
  const explicitQuery = typeof callArgs.query === "string" ? callArgs.query.trim() : "";
  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const fallbackQuery = typeof lastUserMessage?.content === "string" ? lastUserMessage.content.trim() : "";
  const searchText = explicitQuery || fallbackQuery;
  const requestedLimit = typeof callArgs.limit === "number" ? callArgs.limit : undefined;
  const limit = clampRetrievalLimit(requestedLimit);

  if (!searchText) {
    return { ok: false, data: { error: "عبارت جست‌وجو مشخص نیست." } };
  }

  const embedded = await embedOne(config, searchText);
  if (!embedded) {
    return { ok: false, data: { error: "سرویس بردارسازی موقتاً در دسترس نیست." } };
  }

  usage.inputTokens += embedded.inputTokens;
  const hits = await retrieveKnowledge(businessId, embedded.vector, { limit });
  if (hits.length === 0) {
    return {
      ok: true,
      data: {
        matches: [],
        formatted: "موردی در پایگاه دانش این کسب‌وکار یافت نشد.",
        note: "اگر کاربر اطلاعات بیشتری خواست بگو در دانش ثبت‌شده موردی نبود.",
      },
    };
  }

  return {
    ok: true,
    data: {
      matchCount: hits.length,
      matches: hits.map((hit) => ({
        kind: hit.kind,
        refId: hit.refId,
        sourceLabel: hit.sourceLabel,
        content: hit.content,
        similarity: Math.round(hit.similarity * 100) / 100,
      })),
      formatted: formatRetrievalForPrompt(hits),
      note: "از این اطلاعات مستند برای پاسخ دقیق با ذکر منبع استفاده کن.",
    },
  };
}

export async function retrievalReadyForMode(
  config: AiConfig,
  mode: AgentMode,
  businessId?: string | null,
): Promise<boolean> {
  if (mode !== "dashboard" || !businessId) return false;
  const [dbReady, embedReady] = await Promise.all([
    isRetrievalAvailable(),
    isEmbeddingAvailable(config),
  ]);
  return dbReady && embedReady;
}

export interface ChatAttachment {
  kind?: "image" | "pdf";
  name?: string;
  dataUrl?: string;
  extractedText?: string | null;
  truncated?: boolean;
  pageCount?: number;
  byteLength?: number;
  mimeType?: string;
}

function normalizeAttachments(
  attachments?: ChatAttachment[],
  legacySingle?: ChatAttachment,
): ChatAttachment[] {
  if (Array.isArray(attachments) && attachments.length > 0) return attachments;
  if (legacySingle) return [legacySingle];
  return [];
}

/**
 * Runs one agent turn: system prompt + messages + tools -> next action / answer.
 */
export async function runAgentTurn(opts: {
  config: AiConfig;
  mode: AgentMode;
  businessId?: string | null;
  actorUserId?: string | null;
  floorScope?: FloorReadScope;
  promptContext: PromptContext;
  systemPrompt?: string;
  messages: InboundMessage[];
  executeReadTool?: ReadToolRunner;
  stream?: ProviderStreamCallbacks;
  attachment?: ChatAttachment;
  attachments?: ChatAttachment[];
  allowActions?: boolean;
  actionTypes?: ActionType[];
  toolAllowlist?: string[];
  projectScoped?: boolean;
}): Promise<AgentReply> {
  const { config, mode, businessId, floorScope, promptContext, messages } = opts;
  const allowActions = opts.allowActions ?? true;
  const attachments = normalizeAttachments(opts.attachments, opts.attachment);
  const hasAttachment = attachments.length > 0;

  const retrievalReady = await retrievalReadyForMode(config, mode, businessId);

  const tools = toolDefinitions(mode, {
    hasAttachment,
    actionTypes: opts.actionTypes,
    retrieval: retrievalReady,
    toolAllowlist: opts.toolAllowlist,
    projectScoped: opts.projectScoped,
  }).filter((tool) => allowActions || tool.function.name !== "propose_action");
  const allowedActionTypes = opts.actionTypes ? new Set<string>(opts.actionTypes) : null;
  const canPropose = tools.some((tool) => tool.function.name === "propose_action");
  const canRequestInput = tools.some((tool) => tool.function.name === "request_input");
  const allowedReadToolNames = new Set(
    tools
      .map((tool) => tool.function.name)
      .filter((name) => name !== "propose_action" && name !== "request_input"),
  );
  const toolRunner: ReadToolRunner | null =
    opts.executeReadTool ??
    (businessId
      ? (name, args) => runReadTool(name, args, businessId, floorScope, opts.actorUserId ?? undefined)
      : null);
  const usage: AiTokenUsage = { inputTokens: 0, outputTokens: 0 };
  let costUsd: number | null = null;
  const toolTrace: AgentToolCallTrace[] = [];

  const systemContent =
    opts.systemPrompt?.trim() ||
    buildSystemPrompt({
      ...promptContext,
      userName: promptContext.userName ?? undefined,
      role: promptContext.role ?? undefined,
      hasAttachment,
      retrieval: retrievalReady,
    });

  const convo: ProviderMessage[] = [
    { role: "system" as const, content: systemContent },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callProvider(config, convo, tools, opts.stream);
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    if (result.costUsd !== null) costUsd = (costUsd ?? 0) + result.costUsd;
    const message = result.message;
    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      return {
        content: textOf(message.content).trim() || "متوجه نشدم؛ لطفاً دوباره بپرسید.",
        proposedAction: null,
        inputRequest: null,
        usage,
        costUsd,
        toolCalls: toolTrace,
      };
    }

    // A proposed action ends the turn immediately
    const proposal = canPropose
      ? toolCalls.find((c) => c.function.name === "propose_action")
      : undefined;
    if (proposal) {
      const parsed = toProposedAction(parseArgs(proposal.function.arguments));
      const inAllowlist = parsed && (!allowedActionTypes || allowedActionTypes.has(parsed.type));
      const projectOk = parsed && (!ACTION_CATALOG[parsed.type]?.projectScoped || opts.projectScoped);
      const action = parsed && inAllowlist && projectOk ? parsed : null;
      const text = textOf(message.content).trim() || (action ? action.summary : "پیشنهاد آماده است.");
      return { content: text, proposedAction: action, inputRequest: null, usage, costUsd, toolCalls: toolTrace };
    }

    // A structured input request also ends the turn
    const inputCall = canRequestInput
      ? toolCalls.find((c) => c.function.name === "request_input")
      : undefined;
    if (inputCall) {
      const validation = validateInputRequest(parseArgs(inputCall.function.arguments));
      if (validation.ok) {
        const text = textOf(message.content).trim() || validation.spec.prompt;
        return {
          content: text,
          proposedAction: null,
          inputRequest: validation.spec,
          usage,
          costUsd,
          toolCalls: toolTrace,
        };
      }
      convo.push({ role: "assistant", content: textOf(message.content), tool_calls: toolCalls });
      convo.push({
        role: "tool",
        tool_call_id: inputCall.id,
        content: JSON.stringify({ ok: false, error: "invalid_input_request", details: validation.errors }),
      });
      continue;
    }

    // Otherwise execute read tools
    convo.push({ role: "assistant", content: textOf(message.content), tool_calls: toolCalls });
    for (const call of toolCalls) {
      let result: ToolResult;
      const callArgs = parseArgs(call.function.arguments);
      if (call.function.name === "draft_expense_from_receipt" && allowedReadToolNames.has(call.function.name)) {
        const image = attachments.find(
          (item) => (item.kind === "image" || (!item.kind && item.dataUrl?.startsWith("data:image/"))) && item.dataUrl,
        );
        const pdf = attachments.find(
          (item) => item.kind === "pdf" && typeof item.extractedText === "string" && item.extractedText,
        );
        if (image) {
          const extraction = await extractReceiptDraft(config, image.dataUrl!);
          usage.inputTokens += extraction.usage.inputTokens;
          usage.outputTokens += extraction.usage.outputTokens;
          if (extraction.costUsd !== null) costUsd = (costUsd ?? 0) + extraction.costUsd;
          result = extraction.fields
            ? {
                ok: true,
                data: {
                  ...extraction.fields,
                  note: "این یک استخراج خودکار و تخمینی است؛ پیش از تأیید نهایی مقادیر را با کاربر بررسی کن.",
                },
              }
            : { ok: false, data: { error: "استخراج اطلاعات از تصویر پیوست ممکن نشد؛ می‌توانی مقادیر را از کاربر بپرسی." } };
        } else if (pdf) {
          result = {
            ok: true,
            data: {
              source: "pdf",
              receiptText: pdf.extractedText,
              note: "این متن از سند PDF استخراج شده است؛ مبالغ و تاریخ را از داخل همین متن بخوان، هرگز عددی حدس نزن و پیش از پیشنهاد نهایی مقادیر را با کاربر چک کن.",
            },
          };
        } else if (attachments.some((item) => item.kind === "pdf")) {
          result = {
            ok: false,
            data: {
              error:
                "سند PDF پیوست متن قابل استخراج نداشت (احتمالاً اسکن تصویری است)؛ این را به کاربر بگو و مقادیر را از او بپرس.",
            },
          };
        } else {
          result = { ok: false, data: { error: "پیوستی برای این پیام وجود ندارد." } };
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
    inputRequest: null,
    usage,
    costUsd,
    toolCalls: toolTrace,
  };
}
