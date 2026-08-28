/**
 * Phase 35 Wave 6 — retrieval over business knowledge (RAG), with safe
 * degradation when pgvector is not installed.
 *
 * The point of this module is to stop handing the model a whole catalogue and
 * asking it to find the row. Five relevant rows retrieved by meaning is both
 * cheaper and more accurate than a listing the model has to scan.
 *
 * Two rules are load-bearing and are enforced here rather than left to a
 * caller's discipline:
 *
 * 1. **No numbers are ever embedded.** `EMBEDDABLE_KINDS` is slow-moving text
 *    only: help pages, written policy and procedure, item and menu-item
 *    descriptions, project notes (Wave 3), and item/customer names so an
 *    approximate Persian name can be resolved. Orders, payments, stock and
 *    ledger rows are never copied into a vector — a vector copy of a figure on
 *    a POS is stale within minutes and makes the model *confidently* wrong.
 *    Figures are read through tools, at the moment of asking.
 *
 * 2. **Absent extension means absent feature, never a broken assistant.**
 *    `isRetrievalAvailable()` probes once and caches. When it answers false the
 *    retrieval tool is not declared at all, so a café on the desktop installer
 *    (`embedded-postgres`, no `vector` shared library) loses RAG and keeps an
 *    assistant that behaves exactly as it does today.
 *
 * Framework-free: `query` from `db.ts` and nothing else. Retrieval always runs
 * inside the caller's `withTenant` scope — there is no cross-tenant search and
 * no new reason added to `withoutTenantScope`.
 */
import { query } from "./db";

// ---------------------------------------------------------------------------
// What may be embedded
// ---------------------------------------------------------------------------

/**
 * The knowledge kinds that may be embedded. This list is the enforcement point
 * for "no numbers in a vector" — adding an order, payment, stock movement or
 * journal kind here is the mistake this constant exists to prevent.
 */
export const EMBEDDABLE_KINDS = [
  "help",
  "policy",
  "procedure",
  "item",
  "menu_item",
  "project_note",
  "customer",
] as const;

export type EmbeddingKind = (typeof EMBEDDABLE_KINDS)[number];

/**
 * Kinds that carry live figures and are permanently excluded. Kept explicit so
 * a future reviewer sees the decision rather than an omission.
 */
export const NEVER_EMBEDDED_KINDS = [
  "order",
  "order_item",
  "payment",
  "stock_movement",
  "inventory_level",
  "journal_entry",
  "ledger_line",
  "invoice",
  "shift",
] as const;

export function isEmbeddableKind(kind: unknown): kind is EmbeddingKind {
  return typeof kind === "string" && (EMBEDDABLE_KINDS as readonly string[]).includes(kind);
}

/** The dimension of the platform embedding model's output. Matches `vector(1536)`. */
export const EMBEDDING_DIMENSIONS = 1536;

/** Default number of rows a retrieval returns. Five, not fifty. */
export const DEFAULT_RETRIEVAL_LIMIT = 5;

/** Hard ceiling on rows per retrieval, so a caller cannot re-create the catalogue dump. */
export const MAX_RETRIEVAL_LIMIT = 20;

/**
 * Minimum cosine similarity for a row to be worth returning. A weak match
 * presented as knowledge is worse than no match: the model will use it.
 */
export const MIN_SIMILARITY = 0.35;

/** Characters of source text embedded per row. Longer text is chunked by the caller. */
export const MAX_CONTENT_CHARS = 2000;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without a database)
// ---------------------------------------------------------------------------

export interface KnowledgeChunk {
  kind: EmbeddingKind;
  refId: string;
  sourceLabel: string;
  content: string;
  sourceUpdatedAt?: string | null;
}

export interface RetrievalResult {
  kind: EmbeddingKind;
  refId: string;
  /** Names the source — which item, which note, which help page. */
  sourceLabel: string;
  content: string;
  similarity: number;
}

/** Collapses whitespace and clamps to the embedding budget. */
export function normalizeContent(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_CONTENT_CHARS);
}

/**
 * Rejects anything that must not become a vector. Returns the reason so the
 * indexing tick can log it rather than silently dropping work.
 */
export function rejectionReason(chunk: {
  kind: unknown;
  refId?: unknown;
  content?: unknown;
}): string | null {
  if (!isEmbeddableKind(chunk.kind)) return "kind_not_embeddable";
  if (typeof chunk.refId !== "string" || !chunk.refId.trim()) return "missing_ref_id";
  if (typeof chunk.content !== "string" || !normalizeContent(chunk.content)) {
    return "empty_content";
  }
  return null;
}

/** Clamps a caller-supplied limit into the allowed window. */
export function clampRetrievalLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return DEFAULT_RETRIEVAL_LIMIT;
  const n = Math.floor(limit as number);
  if (n < 1) return 1;
  if (n > MAX_RETRIEVAL_LIMIT) return MAX_RETRIEVAL_LIMIT;
  return n;
}

/** Serialises a vector into pgvector's own literal form, `[a,b,c]`. */
export function toVectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding must have ${EMBEDDING_DIMENSIONS} dimensions, received ${vector.length}`,
    );
  }
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error("Embedding contains a non-finite value");
  }
  return `[${vector.join(",")}]`;
}

/**
 * Renders retrieval results for the model. Every line **names its source**, so
 * the reply can be traced back to the item, note or help page it came from —
 * an answer an owner cannot trace is an answer they cannot check.
 */
export function formatRetrievalForPrompt(results: RetrievalResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map(
    (r, i) => `${i + 1}. [${r.kind}: ${r.sourceLabel || r.refId}] ${r.content}`,
  );
  return `دانش بازیابی‌شده از داده‌های همین کسب‌وکار (منبع هر مورد ذکر شده است):\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Availability probe
// ---------------------------------------------------------------------------

let availabilityCache: boolean | null = null;
let availabilityProbe: Promise<boolean> | null = null;

/** Test seam: forget the cached probe result. */
export function resetRetrievalAvailabilityCache(): void {
  availabilityCache = null;
  availabilityProbe = null;
}

/**
 * Whether retrieval can run at all: the `vector` extension is installed *and*
 * migration 0113 got as far as creating the table. Probed once per process —
 * an extension does not appear mid-run — and never throws: a probe that fails
 * for any reason answers "unavailable", which degrades to today's behaviour.
 */
export async function isRetrievalAvailable(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache;
  if (availabilityProbe) return availabilityProbe;
  availabilityProbe = (async () => {
    try {
      const { rows } = await query<{ ok: boolean }>(
        `SELECT (EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
             AND to_regclass('public.ai_embeddings') IS NOT NULL) AS ok`,
      );
      availabilityCache = Boolean(rows[0]?.ok);
    } catch {
      availabilityCache = false;
    } finally {
      availabilityProbe = null;
    }
    return availabilityCache;
  })();
  return availabilityProbe;
}

// ---------------------------------------------------------------------------
// Storage and retrieval
// ---------------------------------------------------------------------------

/**
 * Upserts one knowledge chunk's vector. Silently does nothing when retrieval is
 * unavailable, so an indexing tick needs no branch of its own.
 */
export async function upsertEmbedding(
  businessId: string,
  chunk: KnowledgeChunk,
  embedding: number[],
): Promise<boolean> {
  const reason = rejectionReason(chunk);
  if (reason) throw new Error(`Refusing to embed chunk: ${reason}`);
  if (!(await isRetrievalAvailable())) return false;

  await query(
    `INSERT INTO ai_embeddings
       (business_id, kind, ref_id, source_label, content, embedding, source_updated_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7, now())
     ON CONFLICT (business_id, kind, ref_id) DO UPDATE
        SET source_label      = EXCLUDED.source_label,
            content           = EXCLUDED.content,
            embedding         = EXCLUDED.embedding,
            source_updated_at = EXCLUDED.source_updated_at,
            updated_at        = now()`,
    [
      businessId,
      chunk.kind,
      chunk.refId,
      chunk.sourceLabel ?? "",
      normalizeContent(chunk.content),
      toVectorLiteral(embedding),
      chunk.sourceUpdatedAt ?? null,
    ],
  );
  return true;
}

export interface RetrieveOptions {
  limit?: number;
  kinds?: EmbeddingKind[];
  minSimilarity?: number;
}

/**
 * Retrieves the most similar knowledge rows for a question embedding.
 *
 * Returns `[]` — never throws — when pgvector is missing. The caller (the tool
 * layer) does not declare `search_business_knowledge` in that case, so this is
 * belt and braces, but a retrieval path that can throw would take a chat turn
 * down with it.
 */
export async function retrieveKnowledge(
  businessId: string,
  questionEmbedding: number[],
  options: RetrieveOptions = {},
): Promise<RetrievalResult[]> {
  if (!(await isRetrievalAvailable())) return [];

  const limit = clampRetrievalLimit(options.limit);
  const minSimilarity = options.minSimilarity ?? MIN_SIMILARITY;
  const kinds = (options.kinds ?? []).filter(isEmbeddableKind);

  try {
    const { rows } = await query<{
      kind: string;
      ref_id: string;
      source_label: string;
      content: string;
      similarity: string;
    }>(
      `SELECT kind, ref_id, source_label, content,
              1 - (embedding <=> $2::vector) AS similarity
         FROM ai_embeddings
        WHERE business_id = $1
          ${kinds.length > 0 ? "AND kind = ANY($5::text[])" : ""}
          AND 1 - (embedding <=> $2::vector) >= $4
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      kinds.length > 0
        ? [businessId, toVectorLiteral(questionEmbedding), limit, minSimilarity, kinds]
        : [businessId, toVectorLiteral(questionEmbedding), limit, minSimilarity],
    );
    return rows.filter((r) => isEmbeddableKind(r.kind)).map((r) => ({
      kind: r.kind as EmbeddingKind,
      refId: r.ref_id,
      sourceLabel: r.source_label,
      content: r.content,
      similarity: Number(r.similarity),
    }));
  } catch {
    // A retrieval failure is a missing hint, not a failed answer.
    return [];
  }
}

/** Drops a source's vector — called when the underlying row is deleted. */
export async function deleteEmbedding(
  businessId: string,
  kind: EmbeddingKind,
  refId: string,
): Promise<void> {
  if (!(await isRetrievalAvailable())) return;
  await query(`DELETE FROM ai_embeddings WHERE business_id = $1 AND kind = $2 AND ref_id = $3`, [
    businessId,
    kind,
    refId,
  ]);
}

/** Rows whose source changed since they were embedded, for the indexing tick. */
export async function countStaleEmbeddings(businessId: string): Promise<number> {
  if (!(await isRetrievalAvailable())) return 0;
  const { rows } = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM ai_embeddings
      WHERE business_id = $1
        AND source_updated_at IS NOT NULL
        AND source_updated_at > updated_at`,
    [businessId],
  );
  return Number(rows[0]?.n ?? 0);
}
