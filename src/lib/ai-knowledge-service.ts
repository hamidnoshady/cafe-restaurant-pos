/**
 * Phase I (UI redesign) — the persistence half of the AI Knowledge section.
 *
 * Reads the state of a business's retrieval index (`ai_embeddings`, migration
 * 0113) into the `AiKnowledgeStatus` the `/api/ai/knowledge` route serves.
 * Tenant-scoped through the same `query` helper every service uses (RLS enforces
 * isolation; the explicit `business_id = $1` predicate is defence in depth).
 *
 * Retrieval is optional infra: on a café desktop without pgvector the table may
 * not exist at all. `isRetrievalAvailable()` gates the read so the section can
 * say "retrieval is unavailable" rather than crashing on a missing table — the
 * assistant works either way, it just can't recall from stored text.
 */
import { query } from "./db";
import { EMBEDDABLE_KINDS } from "./ai-rag";
import { isRetrievalAvailable } from "./ai-rag";
import {
  AI_KNOWLEDGE_KIND_HINTS,
  AI_KNOWLEDGE_KIND_LABELS,
  knowledgeKind,
  type AiKnowledgeKindCount,
  type AiKnowledgeStatus,
} from "./ai-knowledge-shared";

interface KindRow extends Record<string, unknown> {
  kind: string;
  count: string | number;
  last_indexed_at: string | null;
}

/**
 * Summarise a business's retrieval index: how many chunks are embedded, per
 * kind, and when each kind was last (re)indexed. `aiConfigured` is passed in
 * (the route already resolved it) so this stays a pure DB read.
 *
 * When retrieval infra is absent the summary reports `retrievalAvailable:false`
 * with every kind at zero — a truthful empty state, not an error.
 */
export async function getAiKnowledgeStatus(
  businessId: string,
  aiConfigured: boolean,
): Promise<AiKnowledgeStatus> {
  const emptyByKind = (): AiKnowledgeKindCount[] =>
    EMBEDDABLE_KINDS.map((kind) => ({
      kind,
      label: AI_KNOWLEDGE_KIND_LABELS[kind],
      hint: AI_KNOWLEDGE_KIND_HINTS[kind],
      count: 0,
      lastIndexedAt: null,
    }));

  if (!(await isRetrievalAvailable())) {
    return {
      retrievalAvailable: false,
      aiConfigured,
      totalChunks: 0,
      lastIndexedAt: null,
      byKind: emptyByKind(),
    };
  }

  const { rows } = await query<KindRow>(
    `SELECT kind,
            count(*)         AS count,
            max(updated_at)  AS last_indexed_at
       FROM ai_embeddings
      WHERE business_id = $1
      GROUP BY kind`,
    [businessId],
  );

  // Fold DB rows into a map, coalescing any unknown/legacy kind out (only the
  // embeddable kinds are surfaced; an unknown one is ignored rather than shown
  // as a stray row the indexer would never refill).
  const counts = new Map<string, { count: number; last: string | null }>();
  for (const row of rows) {
    const kind = knowledgeKind(row.kind);
    if (!kind) continue;
    counts.set(kind, {
      count: Number(row.count),
      last: row.last_indexed_at,
    });
  }

  const byKind: AiKnowledgeKindCount[] = EMBEDDABLE_KINDS.map((kind) => {
    const slice = counts.get(kind);
    return {
      kind,
      label: AI_KNOWLEDGE_KIND_LABELS[kind],
      hint: AI_KNOWLEDGE_KIND_HINTS[kind],
      count: slice?.count ?? 0,
      lastIndexedAt: slice?.last ?? null,
    };
  });

  const totalChunks = byKind.reduce((sum, slice) => sum + slice.count, 0);
  const lastIndexedAt = byKind.reduce<string | null>((latest, slice) => {
    if (!slice.lastIndexedAt) return latest;
    if (!latest || slice.lastIndexedAt > latest) return slice.lastIndexedAt;
    return latest;
  }, null);

  return {
    retrievalAvailable: true,
    aiConfigured,
    totalChunks,
    lastIndexedAt,
    byKind,
  };
}
