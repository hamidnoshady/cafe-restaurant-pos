import { NextRequest, NextResponse } from "next/server";
import { isPlatformAiConfigured } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { reindexBusinessKnowledge } from "@/lib/ai-rag-indexer";
import { requireManager } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/**
 * Phase 36 Wave 6 — the indexing tick, as a manual manager action.
 *
 * Fills `ai_embeddings` from the business's own slow-moving text (menu-item
 * descriptions, item/customer names, project notes) over the shared platform
 * embedding connection. Idempotent: re-running uperts the same rows. When
 * pgvector or the embedding endpoint is unavailable it reports
 * `retrieval: false` and touches nothing — the assistant keeps working either
 * way. `?max=` bounds the run (default 1000, ceiling 5000 chunks).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager();
  if (guard.error) return guard.error;

  const config = await resolveAiConfigFor(guard.session.businessId);
  if (!isPlatformAiConfigured(config)) {
    return NextResponse.json(
      { error: "ai_unavailable", message: "سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم آماده نشده است." },
      { status: 503 },
    );
  }

  const maxParam = Number(new URL(request.url).searchParams.get("max"));
  const maxChunks = Number.isFinite(maxParam) && maxParam > 0 ? Math.floor(maxParam) : undefined;

  const report = await reindexBusinessKnowledge(guard.session.businessId, config, { maxChunks });
  return NextResponse.json(report);
});
