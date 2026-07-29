import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { AgentMode, PromptContext } from "@/lib/ai";
import { getPlatformAiConfig, isPlatformAiConfigured } from "@/lib/ai-config";
import {
  AiInsufficientCreditError,
  cancelAiTurnReservation,
  reserveAiTurn,
  settleAiTurn,
} from "@/lib/ai-billing-service";
import { AiError, runAgentTurn, type InboundMessage } from "@/lib/ai-service";
import { requireManager } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

const MAX_MESSAGES = 24;
const MAX_CONTENT = 8_000;

function sanitizeMessages(raw: unknown): InboundMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: InboundMessage[] = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    if (!m || typeof m !== "object") continue;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content: content.slice(0, MAX_CONTENT) });
    }
  }
  return out;
}

/**
 * Metered assistant turn. The existing feature flag still runs first in
 * withTenantScope; after that, a row-locked maximum reservation prevents two
 * parallel requests from spending the same business balance.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { mode?: unknown; messages?: unknown; currentStep?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const mode: AgentMode = body.mode === "wizard" ? "wizard" : "dashboard";
  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) {
    return NextResponse.json({ error: "empty_messages" }, { status: 400 });
  }

  const config = await getPlatformAiConfig();
  if (!isPlatformAiConfigured(config)) {
    return NextResponse.json(
      { error: "ai_unavailable", message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  let reservation;
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

  try {
    const reply = await runAgentTurn({
      config,
      mode,
      businessId: session.businessId,
      promptContext,
      messages,
    });
    await settleAiTurn({
      businessId: session.businessId,
      reservation,
      usage: reply.usage,
      inputTokenRialPerMillion: config.inputTokenRialPerMillion,
      outputTokenRialPerMillion: config.outputTokenRialPerMillion,
    });
    return NextResponse.json({ content: reply.content, proposedAction: reply.proposedAction });
  } catch (err) {
    await cancelAiTurnReservation({
      businessId: session.businessId,
      reservation,
      reason: err instanceof Error ? err.message : "unknown_error",
    }).catch((cancelError) => console.error("AI credit reservation refund failed", cancelError));

    if (err instanceof AiError) {
      const status = err.code === "ai_auth" ? 502 : err.code === "ai_timeout" ? 504 : 502;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    console.error("ai chat error", err);
    return NextResponse.json({ error: "ai_unknown", message: "خطای غیرمنتظره در دستیار." }, { status: 500 });
  }
});
