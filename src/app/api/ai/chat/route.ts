import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { AgentMode, PromptContext } from "@/lib/ai";
import { getPlatformAiConfig, isPlatformAiConfigured } from "@/lib/ai-config";
import {
  AiInsufficientCreditError,
  cancelAiTurnReservation,
  reserveAiTurn,
  settleAiTurn,
  type AiTurnReservation,
} from "@/lib/ai-billing-service";
import { createAiActionAudit } from "@/lib/ai-action-audit";
import { appendMessage, getOrCreateConversation } from "@/lib/ai-conversations";
import { parseReceiptImageDataUrl } from "@/lib/ai-receipt";
import { AiError, runAgentTurn, type ChatAttachment, type InboundMessage } from "@/lib/ai-service";
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

/**
 * Wave 5 (issue #145) — only dashboard mode (owner/manager) may attach a
 * receipt/invoice image, matching expense.categorize's existing scope. The
 * image is never persisted; on an invalid data URL the whole request is
 * refused rather than silently dropping the attachment.
 */
function parseAttachment(mode: AgentMode, raw: unknown): { attachment: ChatAttachment | null; error: boolean } {
  if (mode !== "dashboard" || !raw || typeof raw !== "object") return { attachment: null, error: false };
  const dataUrl = (raw as { dataUrl?: unknown }).dataUrl;
  if (dataUrl === undefined) return { attachment: null, error: false };
  const parsed = parseReceiptImageDataUrl(dataUrl);
  return parsed ? { attachment: { dataUrl: parsed.dataUrl }, error: false } : { attachment: null, error: true };
}

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
    allowActions?: unknown;
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

  const { attachment, error: attachmentError } = parseAttachment(mode, body.attachment);
  if (attachmentError) {
    return NextResponse.json(
      { error: "attachment_invalid", message: "فرمت یا حجم تصویر پیوست پشتیبانی نمی‌شود." },
      { status: 400 },
    );
  }
  const allowActions = body.allowActions !== false;

  const config = await getPlatformAiConfig();
  if (!isPlatformAiConfigured(config)) {
    return NextResponse.json(
      { error: "ai_unavailable", message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  let reservation: AiTurnReservation;
  try {
    reservation = await reserveAiTurn({
      businessId: session.businessId,
      reservedRial: config.maxTurnRial,
      userId: session.sub,
    });
  } catch (err) {
    if (err instanceof AiInsufficientCreditError) {
      return NextResponse.json(
        { error: "ai_credit_required", message: "اعتبار هوش مصنوعی شما برای یک پاسخ جدید کافی نیست." },
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
  const cacheCandidate = (mode === "dashboard" || mode === "floor") && !attachment && latestPrompt.trim();
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
      let settled = false;
      const emit = (event: string, data: unknown) => controller.enqueue(sse(event, data));

      void (async () => {
        try {
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
              reservation,
              usage: { inputTokens: questionEmbeddingTokens, outputTokens: 0 },
              inputTokenRialPerMillion: config.inputTokenRialPerMillion,
              outputTokenRialPerMillion: config.outputTokenRialPerMillion,
            });
            settled = true;

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
              costRial: settlement.chargedRial + settlement.overageRial,
              cached: true,
              cacheNotice: cachedHit.notice,
            });
            return;
          }

          const reply = await runAgentTurn({
            config,
            mode,
            businessId: session.businessId,
            floorScope:
              mode === "floor" && floorLocation && (session.role === "cashier" || session.role === "waiter")
                ? {
                    locationId: floorLocation.id,
                    userId: session.sub,
                    role: session.role,
                  }
                : undefined,
            promptContext,
            messages,
            attachment: attachment ?? undefined,
            allowActions,
            stream: {
              onDelta: (content) => emit("delta", { content }),
              onToolCalls: () => emit("reset", {}),
            },
          });
          const settlement = await settleAiTurn({
            businessId: session.businessId,
            reservation,
            usage: reply.usage,
            inputTokenRialPerMillion: config.inputTokenRialPerMillion,
            outputTokenRialPerMillion: config.outputTokenRialPerMillion,
          });
          settled = true;

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
            costRial: settlement.chargedRial + settlement.overageRial,
          });
        } catch (err) {
          if (!settled) {
            await cancelAiTurnReservation({
              businessId: session.businessId,
              reservation,
              reason: err instanceof Error ? err.message : "unknown_error",
            }).catch((cancelError) => console.error("AI credit reservation refund failed", cancelError));
          }

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
