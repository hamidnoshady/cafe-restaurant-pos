import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { buildSystemPrompt, type AgentMode, type PromptContext } from "@/lib/ai";
import { isPlatformAiConfigured } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  AiWalletInsufficientError,
  gateAiTurn,
  newAiRequestId,
  settleAiTurn,
} from "@/lib/ai-wallet-billing";
import { createAiActionAudit } from "@/lib/ai-action-audit";
import { appendMessage, getOrCreateConversation } from "@/lib/ai-conversations";
import {
  parseChatAttachments,
  prepareAttachments,
  withAttachmentContext,
} from "@/lib/ai-attachment";
import { taskDirectiveFor } from "@/lib/ai-tasks";
import {
  AiError,
  retrievalReadyForMode,
  runAgentTurn,
  type InboundMessage,
} from "@/lib/ai-service";
import {
  buildToolSignature,
  isCacheableTurn,
  lookupCachedAnswer,
  normalizeRangeDate,
  storeCachedAnswer,
  type CacheHit,
} from "@/lib/ai-answer-cache";
import { embedOne, isEmbeddingAvailable } from "@/lib/ai-embeddings";
import { toolDefinitions } from "@/lib/ai";
import { businessToday } from "@/lib/business-day-service";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { requireFloorAssistant, withTenantScope } from "@/lib/auth";

const MAX_MESSAGES = 24;
const MAX_CONTENT = 8_000;

function sanitizeMessages(raw: unknown): InboundMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: InboundMessage[] = [];
  for (const message of raw.slice(-MAX_MESSAGES)) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content: content.slice(0, MAX_CONTENT) });
    }
  }
  return out;
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Metered assistant turn. Validation and the maximum credit reservation happen
 * before the response starts; then the provider's actual text is relayed as
 * SSE while the same server-side tool/confirmation boundaries stay intact.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  let body: {
    mode?: unknown;
    messages?: unknown;
    currentStep?: unknown;
    conversationId?: unknown;
    attachment?: unknown;
    /** Wave 5 extension — one or more attachments (image and/or PDF). */
    attachments?: unknown;
    allowActions?: unknown;
    /** Phase 36c — the selected task lens (see ai-tasks.ts). */
    task?: unknown;
    /** Phase 36c — a free-form custom task description, wins over `task`. */
    customTask?: unknown;
    /** Phase 36 Wave 7 — «دوباره بپرس»: build a fresh turn, skip the cache. */
    bypassCache?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const mode: AgentMode =
    body.mode === "wizard" ? "wizard" : body.mode === "floor" ? "floor" : "dashboard";
  const guard = mode === "floor" ? await requireFloorAssistant() : await requireManager();
  if (guard.error) return guard.error;
  const session = guard.session;

  const floorLocation = mode === "floor" ? await resolveActiveLocation(session) : null;
  if (mode === "floor" && !floorLocation) {
    return NextResponse.json({ error: "no_location" }, { status: 409 });
  }
  if (
    mode === "floor" &&
    session.role !== "cashier" &&
    session.role !== "waiter"
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) {
    return NextResponse.json({ error: "empty_messages" }, { status: 400 });
  }

  // Wave 5 (issue #145, extended) — only dashboard mode (owner/manager) may
  // attach files (receipt/invoice images and PDF documents), matching
  // expense.categorize's existing scope. Nothing is persisted; on an invalid
  // data URL the whole request is refused rather than silently dropping the
  // attachment. The legacy single-object shape is still accepted.
  const { attachments, error: attachmentError } = parseChatAttachments(
    mode,
    body.attachments ?? body.attachment,
  );
  if (attachmentError) {
    return NextResponse.json(
      {
        error: "attachment_invalid",
        message: "فرمت یا حجم پیوست پشتیبانی نمی‌شود (تصویر حداکثر ۵ مگابایت، PDF حداکثر ۱۰ مگابایت).",
      },
      { status: 400 },
    );
  }
  // PDF text layers are extracted once, before the turn starts.
  const preparedAttachments = await prepareAttachments(attachments);
  const allowActions = body.allowActions !== false;
  const taskDirective = taskDirectiveFor({
    task: body.task,
    customTask: body.customTask,
    mode,
  });

  const activeLocation = await resolveActiveLocation(session);
  const locationId = floorLocation?.id ?? activeLocation?.id ?? null;
  // Phase 37 & 39 — resolved through the gateway: the virtual key, the model alias
  // and the failover chain for THIS business and branch are applied here.
  const config = await resolveAiConfigFor(session.businessId, locationId);
  if (!isPlatformAiConfigured(config)) {
    return NextResponse.json(
      { error: "ai_unavailable", message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  // Phase B — the pre-request affordability gate replaces the credit
  // reservation. It refuses when the business is in AI debt or its wallet is
  // below the per-turn ceiling; it never holds money up front.
  const requestId = newAiRequestId();
  try {
    await gateAiTurn(session.businessId, config);
  } catch (err) {
    if (err instanceof AiWalletInsufficientError) {
      return NextResponse.json(
        { error: "ai_credit_required", message: "اعتبار کیف پول شما برای استفاده از هوش مصنوعی کافی نیست." },
        { status: 402 },
      );
    }
    throw err;
  }

  const { rows } = await query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [
    session.businessId,
  ]);
  const promptContext: PromptContext = {
    mode,
    businessName: rows[0]?.name ?? null,
    currentStep: typeof body.currentStep === "string" ? body.currentStep : null,
    userName: session.fullName,
    role: session.role,
  };
  const latestPrompt = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

  // Best-effort transcript persistence (Wave 1, issue #141) — sits beside the
  // metered turn below, not inside it: it never touches billing and a
  // failure here must not fail an already-reserved turn.
  const requestedConversationId =
    typeof body.conversationId === "string" && body.conversationId.trim()
      ? body.conversationId.trim()
      : null;
  let conversationId: string | null = null;
  try {
    const conversation = await getOrCreateConversation({
      businessId: session.businessId,
      actorUserId: session.sub,
      mode,
      conversationId: requestedConversationId,
      firstMessageContent: latestPrompt,
    });
    conversationId = conversation.id;
    await appendMessage({ conversationId, role: "user", content: latestPrompt });
  } catch (err) {
    console.error("ai conversation persistence failed", err);
  }

  // Phase 36 Wave 7 — the question's embedding, over the shared platform
  // connection, computed once whether this turn is a lookup or a store (a
  // «دوباره بپرس» turn skips the lookup, but its fresh answer is still worth
  // caching). Failed embedding turns the cache off for this turn, never the
  // assistant.
  const bypassCache = body.bypassCache === true;
  const cacheCandidate =
    (mode === "dashboard" || mode === "floor") && attachments.length === 0 && latestPrompt.trim();
  let questionEmbedding: number[] | null = null;
  let questionEmbeddingTokens = 0;
  if (cacheCandidate && (await isEmbeddingAvailable(config))) {
    try {
      const embedded = await embedOne(config, latestPrompt);
      questionEmbedding = embedded.vector;
      questionEmbeddingTokens = embedded.inputTokens;
    } catch {
      questionEmbedding = null;
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, data: unknown) => controller.enqueue(sse(event, data));

      void (async () => {
        try {
          // The code-built system prompt for this surface. The ctx is built
          // with the same attachment/retrieval facts runAgentTurn would use.
          // Phase 36c — the turn's task lens rides on top of it, so no invalid
          // task can leak into the prompt.
          const resolvedPrompt = buildSystemPrompt({
            ...promptContext,
            hasAttachment: attachments.length > 0,
            retrieval: await retrievalReadyForMode(config, mode, session.businessId),
          });
          const systemPrompt = taskDirective
            ? `${resolvedPrompt}\n\n${taskDirective}`
            : resolvedPrompt;

          // Wave 7 — a repeated read-only question inside this trading day
          // answers from the cache, labelled, for the price of an embedding.
          let cachedHit: CacheHit | null = null;
          if (questionEmbedding && !bypassCache) {
            try {
              cachedHit = await lookupCachedAnswer(
                {
                  businessId: session.businessId,
                  locationId: floorLocation?.id ?? null,
                  businessDate: await businessToday(session.businessId),
                  toolSignature: null,
                },
                questionEmbedding,
              );
            } catch {
              cachedHit = null;
            }
          }

          if (cachedHit) {
            const settlement = await settleAiTurn({
              businessId: session.businessId,
              requestId,
              config,
              usage: { inputTokens: questionEmbeddingTokens, outputTokens: 0 },
              costUsd: null,
              cacheHit: true,
              attribution: {
                requestType: "chat",
                model: config.model,
                conversationId,
                locationId,
                userId: session.sub,
                metadata: { mode, cached: true },
              },
            });

            if (conversationId) {
              await appendMessage({
                conversationId,
                role: "assistant",
                content: cachedHit.answer,
              }).catch((err) => console.error("ai conversation persistence failed", err));
            }

            emit("done", {
              content: cachedHit.answer,
              proposedAction: null,
              auditId: null,
              conversationId,
              costRial: settlement.chargedRial,
              cached: true,
              cacheNotice: cachedHit.notice,
            });
            return;
          }

          const reply = await runAgentTurn({
            config,
            mode,
            businessId: session.businessId,
            systemPrompt,
            floorScope:
              mode === "floor" && floorLocation && (session.role === "cashier" || session.role === "waiter")
                ? {
                    locationId: floorLocation.id,
                    userId: session.sub,
                    role: session.role,
                  }
                : undefined,
            promptContext,
            messages: withAttachmentContext(messages, preparedAttachments),
            attachments: preparedAttachments,
            allowActions,
            stream: {
              onDelta: (content) => emit("delta", { content }),
              onToolCalls: () => emit("reset", {}),
            },
          });
          // Phase B — settle the REAL cost against the platform wallet. The
          // gateway's reported USD (plus the platform margin) is preferred;
          // the token rates are the fallback when the gateway did not price
          // the turn. No reservation was held, so this is the only debit.
          const settlement = await settleAiTurn({
            businessId: session.businessId,
            requestId,
            config,
            usage: reply.usage,
            costUsd: reply.costUsd,
            attribution: {
              requestType: "chat",
              model: config.model,
              conversationId,
              locationId,
              userId: session.sub,
              metadata: { mode },
            },
          });

          const auditId = reply.proposedAction
            ? await createAiActionAudit({
                businessId: session.businessId,
                actorUserId: session.sub,
                actorName: session.fullName,
                prompt: latestPrompt,
                proposal: reply.proposedAction,
              })
            : null;

          if (conversationId) {
            await appendMessage({
              conversationId,
              role: "assistant",
              content: reply.content,
              proposal: reply.proposedAction,
            }).catch((err) => console.error("ai conversation persistence failed", err));
          }

          // Wave 7 — cache the answer only when the turn was provably
          // read-only: no proposal and nothing outside the mode's read tools.
          // `storeCachedAnswer` re-checks the same gate, so a future edit to
          // this route cannot forget it.
          const readToolNames = toolDefinitions(mode, { hasAttachment: false })
            .filter((tool) => tool.function.name !== "propose_action")
            .map((tool) => tool.function.name);
          const toolsUsed = reply.toolCalls.map((call) => call.name);
          const turnShape = {
            mode,
            toolsUsed,
            proposedAction: Boolean(reply.proposedAction),
            readToolNames,
          };
          if (questionEmbedding && isCacheableTurn(turnShape)) {
            const toolSignature = buildToolSignature(
              reply.toolCalls.map((call) => ({
                tool: call.name,
                from: normalizeRangeDate(call.dateFrom),
                to: normalizeRangeDate(call.dateTo),
              })),
            );
            await storeCachedAnswer(
              {
                businessId: session.businessId,
                locationId: floorLocation?.id ?? null,
                businessDate: await businessToday(session.businessId),
                toolSignature,
              },
              {
                questionText: latestPrompt,
                questionEmbedding,
                answer: reply.content,
                turn: turnShape,
              },
            ).catch(() => {});
          }

          emit("done", {
            content: reply.content,
            proposedAction: reply.proposedAction,
            auditId,
            conversationId,
            // What this turn actually cost, so the client can say so under the
            // reply. It replaces the pre-send estimate card, which charged the
            // user an extra round trip and a tap to show a *guess*.
            costRial: settlement.chargedRial,
          });
        } catch (err) {
          // Phase B — no reservation to refund. A turn that failed before the
          // provider answered cost nothing, so nothing is settled; a turn that
          // failed after already paying upstream has (in the happy path) been
          // settled above. Nothing to undo here.
          if (err instanceof AiError) {
            emit("error", { error: err.code, message: err.message });
          } else {
            console.error("ai chat error", err);
            emit("error", { error: "ai_unknown", message: "خطای غیرمنتظره در دستیار." });
          }
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
