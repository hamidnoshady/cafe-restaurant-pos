/**
 * Phase 36 Wave 6 — the indexing tick. The one job `ai-rag.ts` deliberately
 * left to a caller: turning the business's own slow-moving text into vectors.
 *
 * What it embeds, per `EMBEDDABLE_KINDS`, is only what actually has a table
 * today — menu-item descriptions, inventory-item names, customer *names* and
 * project notes. `help`, `policy` and `procedure` have no tables yet, so they
 * are skipped, not fabricated. What it never embeds is everything in
 * `NEVER_EMBEDDED_KINDS`: no order, payment, stock figure or ledger line ever
 * becomes a vector (see ai-rag.ts for the reasoning — a stale copy of a
 * number makes the model confidently wrong about money).
 *
 * Bounded by design: at most `maxChunks` chunks per run (a manual, replayable
 * tick — not a schema-wide promise), embedded `EMBED_BATCH_SIZE` at a time.
 * Vectors whose source row disappeared are dropped, but only for kinds that
 * were *not* truncated — deleting from a partial id list would nuke good rows.
 *
 * Every failure is contained: an unavailable extension, an unusable embedding
 * endpoint or a rejected chunk is reported in the result, never thrown, so a
 * caller can run this from a route without risking the request.
 */
import type { AiConfig } from "./ai";
import { query } from "./db";
import { EMBED_BATCH_SIZE, embedTexts, isEmbeddingAvailable } from "./ai-embeddings";
import {
  isRetrievalAvailable,
  normalizeContent,
  rejectionReason,
  upsertEmbedding,
  type EmbeddingKind,
  type KnowledgeChunk,
} from "./ai-rag";

export const DEFAULT_MAX_CHUNKS = 1000;
export const MAX_CHUNKS_CEILING = 5000;

export interface ReindexReport {
  /** Whether retrieval infra exists at all; false means nothing was touched. */
  retrieval: boolean;
  embedded: number;
  /** Chunks refused by `rejectionReason` — logged, never silently dropped. */
  skipped: string[];
  /** Vectors dropped because their source row is gone. */
  deleted: number;
  /** True when maxChunks cut a kind short; its delete step was skipped. */
  truncated: boolean;
}

interface CollectedKind {
  kind: EmbeddingKind;
  chunks: KnowledgeChunk[];
  truncated: boolean;
}

function menuContent(name: string, description: string): string {
  const desc = normalizeContent(description);
  return desc ? `${name} — ${desc}` : name;
}

async function collectMenuItems(businessId: string, limit: number): Promise<CollectedKind> {
  const { rows } = await query<{ ref_id: string; name: string; description: string | null; ts: string | null }>(
    `SELECT mi.id::text AS ref_id, mi.name, mi.description, mi.updated_at::text AS ts
       FROM menu_items mi
       JOIN locations l ON l.id = mi.location_id
      WHERE l.business_id = $1
      ORDER BY mi.updated_at DESC
      LIMIT $2`,
    [businessId, limit + 1],
  );
  const truncated = rows.length > limit;
  return {
    kind: "menu_item",
    truncated,
    chunks: rows.slice(0, limit).map((r) => ({
      kind: "menu_item" as const,
      refId: r.ref_id,
      sourceLabel: r.name,
      content: menuContent(r.name, r.description ?? ""),
      sourceUpdatedAt: r.ts,
    })),
  };
}

async function collectInventoryItems(businessId: string, limit: number): Promise<CollectedKind> {
  const { rows } = await query<{ ref_id: string; name: string; unit: string }>(
    `SELECT ii.id::text AS ref_id, ii.name, ii.unit
       FROM inventory_items ii
       JOIN locations l ON l.id = ii.location_id
      WHERE l.business_id = $1
      ORDER BY ii.created_at DESC
      LIMIT $2`,
    [businessId, limit + 1],
  );
  const truncated = rows.length > limit;
  return {
    kind: "item",
    truncated,
    chunks: rows.slice(0, limit).map((r) => ({
      kind: "item" as const,
      refId: r.ref_id,
      sourceLabel: r.name,
      content: r.unit ? `${r.name} (واحد: ${r.unit})` : r.name,
    })),
  };
}

async function collectCustomers(businessId: string, limit: number): Promise<CollectedKind> {
  // Names only — a customer note can carry figures, and figures never become
  // vectors. This is the customer half of "no numbers in a vector".
  const { rows } = await query<{ ref_id: string; name: string }>(
    `SELECT id::text AS ref_id, name FROM parties WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [businessId, limit + 1],
  );
  const truncated = rows.length > limit;
  return {
    kind: "customer",
    truncated,
    chunks: rows.slice(0, limit).map((r) => ({
      kind: "customer" as const,
      refId: r.ref_id,
      sourceLabel: r.name,
      content: r.name,
    })),
  };
}

async function collectProjectNotes(businessId: string, limit: number): Promise<CollectedKind> {
  const { rows } = await query<{
    ref_id: string;
    project: string;
    title: string;
    content: string;
    ts: string | null;
  }>(
    `SELECT n.id::text AS ref_id, p.name AS project, n.title, n.content, n.created_at::text AS ts
       FROM ai_project_notes n
       JOIN ai_projects p ON p.id = n.project_id
      WHERE p.business_id = $1 AND p.archived_at IS NULL
      ORDER BY n.created_at DESC
      LIMIT $2`,
    [businessId, limit + 1],
  );
  const truncated = rows.length > limit;
  return {
    kind: "project_note",
    truncated,
    chunks: rows.slice(0, limit).map((r) => ({
      kind: "project_note" as const,
      refId: r.ref_id,
      sourceLabel: r.project,
      content: r.title ? `${r.title} — ${r.content}` : r.content,
      sourceUpdatedAt: r.ts,
    })),
  };
}

/** Drops vectors whose source row is gone — only for kinds seen in full. */
async function deleteVanished(businessId: string, kind: CollectedKind): Promise<number> {
  if (kind.truncated || kind.chunks.length === 0) return 0;
  const ids = kind.chunks.map((chunk) => chunk.refId);
  const { rowCount } = await query(
    `DELETE FROM ai_embeddings
      WHERE business_id = $1 AND kind = $2 AND NOT (ref_id = ANY($3::text[]))`,
    [businessId, kind.kind, ids],
  );
  return rowCount ?? 0;
}

/**
 * One bounded indexing run over the business's embeddable text. Returns a
 * report rather than throwing so the manual route can show what happened.
 */
export async function reindexBusinessKnowledge(
  businessId: string,
  config: AiConfig,
  opts: { maxChunks?: number } = {},
): Promise<ReindexReport> {
  const ceiling = Math.min(opts.maxChunks ?? DEFAULT_MAX_CHUNKS, MAX_CHUNKS_CEILING);
  const report: ReindexReport = {
    retrieval: false,
    embedded: 0,
    skipped: [],
    deleted: 0,
    truncated: false,
  };

  if (!(await isRetrievalAvailable())) return report;
  if (!(await isEmbeddingAvailable(config))) return report;
  report.retrieval = true;

  const kinds: CollectedKind[] = [];
  const perKindCap = Math.max(50, Math.floor(ceiling / 4));
  for (const collect of [collectMenuItems, collectInventoryItems, collectCustomers, collectProjectNotes]) {
    try {
      kinds.push(await collect(businessId, perKindCap));
    } catch (err) {
      console.error("ai rag indexer: collect failed", err);
    }
  }
  report.truncated = kinds.some((kind) => kind.truncated);

  const pending: KnowledgeChunk[] = [];
  for (const kind of kinds) {
    for (const chunk of kind.chunks) {
      const reason = rejectionReason(chunk);
      if (reason) {
        if (report.skipped.length < 20) report.skipped.push(`${chunk.kind}:${reason}`);
        continue;
      }
      pending.push(chunk);
    }
  }
  const capped = pending.slice(0, ceiling);

  for (let offset = 0; offset < capped.length; offset += EMBED_BATCH_SIZE) {
    const batch = capped.slice(offset, offset + EMBED_BATCH_SIZE);
    let vectors: number[][];
    try {
      vectors = (await embedTexts(config, batch.map((chunk) => chunk.content))).vectors;
    } catch (err) {
      console.error("ai rag indexer: embedding batch failed", err);
      break;
    }
    for (let i = 0; i < batch.length; i++) {
      try {
        if (await upsertEmbedding(businessId, batch[i], vectors[i])) report.embedded++;
      } catch (err) {
        console.error("ai rag indexer: upsert failed", err);
      }
    }
  }

  for (const kind of kinds) {
    try {
      report.deleted += await deleteVanished(businessId, kind);
    } catch (err) {
      console.error("ai rag indexer: delete vanished failed", err);
    }
  }

  return report;
}
