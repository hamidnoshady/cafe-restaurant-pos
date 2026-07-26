import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { AgentMode, PromptContext } from "@/lib/ai";
import { getAiConfig } from "@/lib/ai-config";
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
 * The assistant turn. Owner/Manager only. Read tools run server-side; a mutation
 * comes back as `proposedAction` for the browser to confirm and apply.
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

  const config = await getAiConfig(session.businessId);
  if (!config.enabled || !config.apiKey) {
    return NextResponse.json({ error: "ai_disabled" }, { status: 409 });
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
    return NextResponse.json(reply);
  } catch (err) {
    if (err instanceof AiError) {
      const status = err.code === "ai_auth" ? 502 : err.code === "ai_timeout" ? 504 : 502;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    console.error("ai chat error", err);
    return NextResponse.json({ error: "ai_unknown", message: "خطای غیرمنتظره در دستیار." }, { status: 500 });
  }
});
