import { NextRequest, NextResponse } from "next/server";
import {
  BUSINESS_PROMPT_SURFACES,
  MAX_BUSINESS_INSTRUCTIONS_CHARS,
  deleteBusinessOverride,
  isBusinessPromptSurface,
  listBusinessOverrides,
  saveBusinessOverride,
} from "@/lib/ai-prompt-service";
import { requireManager } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/**
 * The prompt manager's business layer: standing instructions that shape the
 * business's own assistant on the surfaces it uses. Read, save and remove —
 * nothing here can replace the platform prompt or its confirm-before-write
 * rules; instructions are appended, never substituted.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const overrides = await listBusinessOverrides(session.businessId);
  return NextResponse.json({
    overrides,
    surfaces: BUSINESS_PROMPT_SURFACES,
    maxChars: MAX_BUSINESS_INSTRUCTIONS_CHARS,
  });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { surface?: unknown; instructions?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!isBusinessPromptSurface(body.surface)) {
    return NextResponse.json({ error: "bad_surface" }, { status: 400 });
  }
  const instructions = typeof body.instructions === "string" ? body.instructions : "";
  if (!instructions.trim()) {
    return NextResponse.json({ error: "empty_instructions" }, { status: 400 });
  }
  if (instructions.length > MAX_BUSINESS_INSTRUCTIONS_CHARS) {
    return NextResponse.json({ error: "too_long" }, { status: 400 });
  }

  try {
    await saveBusinessOverride({
      businessId: session.businessId,
      surface: body.surface,
      instructions,
      updatedBy: session.fullName || session.sub,
    });
  } catch (err) {
    if (err instanceof Error && (err.message === "empty_instructions" || err.message === "too_long")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  const surface = new URL(request.url).searchParams.get("surface");
  if (!isBusinessPromptSurface(surface)) {
    return NextResponse.json({ error: "bad_surface" }, { status: 400 });
  }
  await deleteBusinessOverride(session.businessId, surface);
  return NextResponse.json({ ok: true });
});
