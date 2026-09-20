/**
 * Phase I (UI redesign) — the pure core of the AI *Knowledge* section.
 *
 * The assistant retrieves over a business's own slow-moving text (menu and item
 * descriptions, item/customer names, project notes, help/policy/procedure) via
 * pgvector embeddings (`ai_embeddings`, migration 0113). Numbers are never
 * embedded — orders, stock, payments and ledger rows stay where they are and
 * are read through tools. The Knowledge section makes that index visible: what
 * the assistant can recall, broken down by kind, whether retrieval infra is
 * even available, and a manual reindex.
 *
 * Framework-free (no `next`, no `db`, no JSX) so the service, the API route, the
 * client section and the unit tests share one source of truth: the embeddable
 * kinds and their Persian labels can never drift between the breakdown and the
 * indexer that fills it.
 */
import { EMBEDDABLE_KINDS, type EmbeddingKind } from "./ai-rag";

/** The Persian label each embeddable kind reads as in the section. */
export const AI_KNOWLEDGE_KIND_LABELS: Record<EmbeddingKind, string> = {
  help: "راهنما",
  policy: "سیاست‌ها",
  procedure: "روش‌های کاری",
  item: "کالاها",
  menu_item: "اقلام منو",
  project_note: "یادداشت پروژه‌ها",
  customer: "مشتریان",
};

/** A one-line description of what each kind contributes to retrieval. */
export const AI_KNOWLEDGE_KIND_HINTS: Record<EmbeddingKind, string> = {
  help: "متن راهنمای بخش‌های نرم‌افزار",
  policy: "سیاست‌های نوشته‌شدهٔ کسب‌وکار",
  procedure: "روال‌ها و دستورالعمل‌های کاری",
  item: "نام و توضیح کالاهای انبار",
  menu_item: "نام و توضیح اقلام منو",
  project_note: "یادداشت‌های داخل پروژه‌ها",
  customer: "نام مشتریان برای یافتن تقریبی",
};

/** Map a raw stored `kind` to a known embeddable kind, or null if unknown. */
export function knowledgeKind(raw: string | null | undefined): EmbeddingKind | null {
  return raw && (EMBEDDABLE_KINDS as readonly string[]).includes(raw)
    ? (raw as EmbeddingKind)
    : null;
}

/** The Persian label for a raw or known kind; unknown falls back to the raw name. */
export function knowledgeKindLabel(raw: string | null | undefined): string {
  const kind = knowledgeKind(raw);
  return kind ? AI_KNOWLEDGE_KIND_LABELS[kind] : String(raw ?? "");
}

/** One kind's slice of the index. */
export interface AiKnowledgeKindCount {
  kind: EmbeddingKind;
  label: string;
  hint: string;
  count: number;
  /** The most recent time any chunk of this kind was (re)embedded. */
  lastIndexedAt: string | null;
}

/** The whole Knowledge payload the API returns and the section renders. */
export interface AiKnowledgeStatus {
  /**
   * Whether retrieval infra exists at all (pgvector + the table). When false
   * the section explains that RAG is unavailable rather than showing an empty
   * index — the assistant still works, it just can't recall from stored text.
   */
  retrievalAvailable: boolean;
  /** Whether the platform AI (embedding) connection is configured. */
  aiConfigured: boolean;
  /** Total embedded chunks across every kind. */
  totalChunks: number;
  /** The most recent (re)index time across the whole index. */
  lastIndexedAt: string | null;
  /** Per-kind breakdown, every embeddable kind present (count 0 when empty). */
  byKind: AiKnowledgeKindCount[];
}

/** The outcome of a manual reindex, as the section shows it. */
export interface AiKnowledgeReindexResult {
  retrieval: boolean;
  embedded: number;
  skipped: string[];
  deleted: number;
  truncated: boolean;
}
