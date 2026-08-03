import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { AgentMode, PromptContext } from "@/lib/ai";
import { getPlatformAiConfig, isPlatformAiConfigured } from "@/lib/ai-config";
import { estimateAiTurn } from "@/lib/ai-estimate";
import type { InboundMessage } from "@/lib/ai-service";
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

/**
 * A no-provider, no-credit-hold preview shown before a user starts a metered
 * assistant turn. The chat route still remains the only place that reserves
 * and settles actual credit.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  let body: { mode?: unknown; messages?: unknown; currentStep?: unknown };
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

  if (mode === "floor") {
    const floorLocation = await resolveActiveLocation(session);
    if (!floorLocation) return NextResponse.json({ error: "no_location" }, { status: 409 });
    if (session.role !== "cashier" && session.role !== "waiter") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
  }

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

  return NextResponse.json(
    estimateAiTurn({
      mode,
      promptContext,
      messages,
      maxOutputTokens: config.maxOutputTokens,
      maxTurnRial: config.maxTurnRial,
      rates: {
        inputTokenRialPerMillion: config.inputTokenRialPerMillion,
        outputTokenRialPerMillion: config.outputTokenRialPerMillion,
      },
    }),
  );
});
