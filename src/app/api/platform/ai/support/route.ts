import { NextRequest, NextResponse } from "next/server";
import { getPlatformAiConfig, isPlatformAiProviderReady } from "@/lib/ai-config";
import { AiError, runAgentTurn, type InboundMessage } from "@/lib/ai-service";
import { runPlatformReadTool } from "@/lib/ai-platform-tools";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";

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
 * Separate, unmetered platform-support agent. It uses the platform provider
 * connection but never reserves/debits a tenant balance and has no tenant
 * action catalogue. withPlatformScope establishes the platform bypass; its
 * executor exposes only platform-health read tools.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const guard = await requirePlatformCapability("ai.read");
  if (guard.error) return guard.error;

  let body: { messages?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const messages = sanitizeMessages(body.messages);
  if (messages.length === 0) {
    return NextResponse.json({ error: "empty_messages" }, { status: 400 });
  }

  const config = await getPlatformAiConfig();
  if (!isPlatformAiProviderReady(config)) {
    return NextResponse.json(
      { error: "ai_unavailable", message: "اتصال سراسری هوش مصنوعی برای پشتیبانی پلتفرم آماده نیست." },
      { status: 503 },
    );
  }

  try {
    const reply = await runAgentTurn({
      config,
      mode: "platform",
      promptContext: {
        mode: "platform",
        userName: guard.session.fullName,
        role: `platform-${guard.session.role}`,
      },
      messages,
      executeReadTool: runPlatformReadTool,
    });
    await platformAudit({
      adminId: guard.session.padmin,
      action: "ai.support.query",
      entity: "platform_ai_support",
      entityId: null,
      payload: { mode: "platform_health_only" },
    });
    return NextResponse.json({ content: reply.content });
  } catch (err) {
    if (err instanceof AiError) {
      const status = err.code === "ai_auth" ? 502 : err.code === "ai_timeout" ? 504 : 502;
      return NextResponse.json({ error: err.code, message: err.message }, { status });
    }
    console.error("platform support AI error", err);
    return NextResponse.json(
      { error: "ai_unknown", message: "خطای غیرمنتظره در دستیار پشتیبانی پلتفرم." },
      { status: 500 },
    );
  }
});
