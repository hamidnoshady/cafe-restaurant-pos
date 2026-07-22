import { NextRequest, NextResponse } from "next/server";
import { PROVIDERS, toPublicConfig, validateConfigInput, type AiProvider } from "@/lib/ai";
import { getAiConfig, saveAiConfig } from "@/lib/ai-config";
import { requireManager } from "@/lib/setup-state";

/** Current AI assistant config (key redacted) plus provider defaults for the UI. */
export async function GET() {
  const { session, error } = await requireManager();
  if (error) return error;

  const config = await getAiConfig(session.businessId);
  return NextResponse.json({
    config: toPublicConfig(config),
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      defaultBaseUrl: p.defaultBaseUrl,
      defaultModel: p.defaultModel,
    })),
  });
}

/** Save AI assistant config. A blank apiKey keeps the previously stored key. */
export async function PUT(request: NextRequest) {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const errors = validateConfigInput(body);
  if (errors.length > 0) {
    return NextResponse.json({ error: errors[0], errors }, { status: 400 });
  }

  const saved = await saveAiConfig(session.businessId, {
    enabled: Boolean(body.enabled),
    provider: body.provider as AiProvider,
    model: String(body.model),
    baseUrl: String(body.baseUrl),
    apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    temperature: Number(body.temperature ?? 0.3),
  });

  return NextResponse.json({ ok: true, config: toPublicConfig(saved) });
}
