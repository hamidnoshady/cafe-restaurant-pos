import { NextRequest, NextResponse } from "next/server";
import { buildSystemPrompt, type AgentMode } from "@/lib/ai";
import {
  clearPlatformSurfacePrompt,
  listPlatformPromptSurfaces,
  PLATFORM_PROMPT_SURFACES,
  savePlatformSurfacePrompt,
} from "@/lib/ai-prompt-service";
import {
  platformAudit,
  requirePlatformCapability,
  withPlatformScope,
} from "@/lib/platform-auth";

function parseMode(value: unknown): AgentMode | null {
  return typeof value === "string" && (PLATFORM_PROMPT_SURFACES as string[]).includes(value)
    ? (value as AgentMode)
    : null;
}

/**
 * The prompt manager's platform layer: every surface the assistant answers
 * on, its active override, its version history, and the code default it falls
 * back to — so an admin edits with the real baseline in front of them.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("ai.read");
  if (error) return error;

  const surfaces = await listPlatformPromptSurfaces();
  return NextResponse.json({
    surfaces: surfaces.map((surface) => ({
      ...surface,
      codeDefault: buildSystemPrompt({ mode: surface.mode }),
    })),
  });
});

/** Saves a new active version of one surface's prompt (owner-level). */
export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  let body: { mode?: unknown; text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const mode = parseMode(body.mode);
  const text = typeof body.text === "string" ? body.text : "";
  if (!mode) return NextResponse.json({ error: "bad_surface" }, { status: 400 });
  if (!text.trim()) return NextResponse.json({ error: "empty_prompt" }, { status: 400 });
  if (text.length > 20_000) return NextResponse.json({ error: "too_long" }, { status: 400 });

  try {
    await savePlatformSurfacePrompt({ mode, text, createdBy: session.padmin });
  } catch (err) {
    if (err instanceof Error && err.message === "empty_prompt") {
      return NextResponse.json({ error: "empty_prompt" }, { status: 400 });
    }
    throw err;
  }
  await platformAudit({
    adminId: session.padmin,
    action: "ai.prompt.save",
    entity: "ai_prompt_templates",
    entityId: `surface:${mode}`,
    payload: { mode, length: text.length },
  });
  return NextResponse.json({ ok: true });
});

/** Drops the active override — the surface falls back to its code default. */
export const DELETE = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  const mode = parseMode(new URL(request.url).searchParams.get("mode"));
  if (!mode) return NextResponse.json({ error: "bad_surface" }, { status: 400 });

  await clearPlatformSurfacePrompt(mode);
  await platformAudit({
    adminId: session.padmin,
    action: "ai.prompt.clear",
    entity: "ai_prompt_templates",
    entityId: `surface:${mode}`,
    payload: { mode },
  });
  return NextResponse.json({ ok: true });
});
