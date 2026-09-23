/**
 * Phase 35 Wave 7 — a semantic cache for assistant answers, bound to the
 * branch's business day and to the tool signature the answer was built from.
 *
 * «فروش دیروز چقدر بود؟» gets asked three times in one branch. The second and
 * third should not cost a turn. Because this wave is about money, it has two
 * hard rules, and both live in the key:
 *
 * 1. **Only read-only turns are cached.** A turn that produced a
 *    `propose_action`, or that called anything outside the read-tool set, is
 *    never stored — `isCacheableTurn` is the single gate and it fails closed.
 *
 * 2. **The key contains the branch's business day, not the calendar date.**
 *    Per CLAUDE.md, "which day did this happen on" means
 *    `app_business_date(ts, tz, start_minutes)`. A café trading 18:00–03:00
 *    runs one service, not two; a key built from the calendar date carries the
 *    pre-midnight answer into the next service.
 *
 * On top of that the key carries a **tool signature** — the names and ranges
 * the answer was built from. That is what makes «فروش امروز» survive neither
 * the trading day rolling over nor a late-arriving sale (a closed-order
 * amendment, an imported invoice) landing inside the same range: a figure that
 * changes after the fact changes the very window the answer summarised.
 *
 * Like Wave 6, the whole thing is off when pgvector is absent, and off means
 * exactly today's behaviour.
 */
import { query } from "./db";
import { toVectorLiteral, EMBEDDING_DIMENSIONS } from "./ai-rag";

export { EMBEDDING_DIMENSIONS };

/**
 * Conservative. A wrong answer to a slightly different question costs more
 * than the fresh turn it saved — an owner who catches one stops trusting all
 * of them.
 */
export const CACHE_SIMILARITY_THRESHOLD = 0.94;

/** Safety net under the signature, not the main guard. */
export const CACHE_TTL_SECONDS = 3600;

/** The label a cached answer is shown behind. Never silent — the user must know. */
export const CACHE_NOTICE = "پاسخ پیش‌تر ساخته‌شده در همین روز کاری";

// ---------------------------------------------------------------------------
// Cacheability — the read-only gate
// ---------------------------------------------------------------------------

/** Agent modes whose turns may be cached. `wizard` and `autopilot` never are. */
export const CACHEABLE_MODES = ["dashboard", "floor"] as const;
export type CacheableMode = (typeof CACHEABLE_MODES)[number];

export interface TurnShape {
  mode: string;
  /** Every tool the turn invoked, in call order. */
  toolsUsed: string[];
  /** True if the turn emitted a write proposal. */
  proposedAction: boolean;
  /** The set of tools considered read-only for this turn. */
  readToolNames: string[];
}

/**
 * The single gate. Fails closed: anything unrecognised is not cached.
 *
 * A turn is cacheable only when the mode is a plain question-answering mode,
 * nothing was proposed, and every tool it touched is a read tool.
 */
export function isCacheableTurn(turn: TurnShape): boolean {
  if (turn.proposedAction) return false;
  if (!(CACHEABLE_MODES as readonly string[]).includes(turn.mode)) return false;
  const readTools = new Set(turn.readToolNames);
  return turn.toolsUsed.every((name) => readTools.has(name));
}

// ---------------------------------------------------------------------------
// Tool signature
// ---------------------------------------------------------------------------

export interface ToolCallRange {
  tool: string;
  /** Inclusive business-date range the call read, when it had one. */
  from?: string | null;
  to?: string | null;
}

/**
 * Canonical, order-independent signature of what an answer was built from.
 * Sorting is what makes it order-independent: the model may call the same two
 * tools in either order and must land on one key.
 */
export function buildToolSignature(calls: ToolCallRange[]): string {
  if (calls.length === 0) return "none";
  const parts = calls.map((c) => `${c.tool}:${c.from ?? "*"}..${c.to ?? "*"}`);
  return [...new Set(parts)].sort().join("|");
}

/** Whether a write touching `[from, to]` invalidates an answer built from `signature`. */
export function signatureTouchesRange(
  signature: string,
  range: { from: string; to: string },
): boolean {
  if (signature === "none") return false;
  return signature.split("|").some((part) => {
    const spec = part.slice(part.indexOf(":") + 1);
    const [from, to] = spec.split("..");
    const lower = from === "*" ? null : from;
    const upper = to === "*" ? null : to;
    if (lower !== null && range.to < lower) return false;
    if (upper !== null && range.from > upper) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

let availabilityCache: boolean | null = null;

/** Test seam: forget the cached probe result. */
export function resetAnswerCacheAvailability(): void {
  availabilityCache = null;
}

/**
 * Whether the cache can run: pgvector installed and migration 0114 having
 * created the table. Never throws — a failed probe means "off", and off is
 * today's behaviour.
 */
export async function isAnswerCacheAvailable(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache;
  try {
    const { rows } = await query<{ ok: boolean }>(
      `SELECT (EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
           AND to_regclass('public.ai_answer_cache') IS NOT NULL) AS ok`,
    );
    availabilityCache = Boolean(rows[0]?.ok);
  } catch {
    availabilityCache = false;
  }
  return availabilityCache;
}

// ---------------------------------------------------------------------------
// Lookup and store
// ---------------------------------------------------------------------------

export interface CacheKey {
  businessId: string;
  locationId: string | null;
  /** The branch's trading day from `app_business_date`, `YYYY-MM-DD`. */
  businessDate: string;
  /**
   * The exact tool signature a lookup demands, or null to match any. Storing
   * always records the turn's true signature; it is the *lookup* that cannot
   * know which tools a not-yet-run turn would use, so the chat path looks up
   * with null: similarity ≥ threshold over a same-day, same-branch question is
   * the premise that the previous answer's tools are the ones this question
   * needs. Invalidation still works off each row's stored signature.
   */
  toolSignature: string | null;
}

export interface CacheHit {
  id: string;
  answer: string;
  questionText: string;
  similarity: number;
  hitCount: number;
  /** Always set — a cached answer is labelled, never passed off as fresh. */
  notice: string;
}

export interface LookupOptions {
  /** «دوباره بپرس»: the user asked for a fresh turn, so the cache is skipped. */
  bypass?: boolean;
  threshold?: number;
}

/**
 * Looks for an answer already built today from the same tools. A hit requires
 * **all four**: similarity over the threshold, the same `business_date`, a
 * matching `tool_signature` (any, when the key's is null), and `expires_at`
 * not passed. The first three are the correctness argument; the fourth is the
 * safety net.
 */
export async function lookupCachedAnswer(
  key: CacheKey,
  questionEmbedding: number[],
  options: LookupOptions = {},
): Promise<CacheHit | null> {
  if (options.bypass) return null;
  if (!(await isAnswerCacheAvailable())) return null;

  const threshold = options.threshold ?? CACHE_SIMILARITY_THRESHOLD;
  try {
    const { rows } = await query<{
      id: string;
      answer: string;
      question_text: string;
      hit_count: number;
      similarity: string;
    }>(
      `SELECT id, answer, question_text, hit_count,
              1 - (question_embedding <=> $5::vector) AS similarity
         FROM ai_answer_cache
        WHERE business_id = $1
          AND location_id IS NOT DISTINCT FROM $2
          AND business_date = $3
          AND ($4::text IS NULL OR tool_signature = $4)
          AND expires_at > now()
          AND 1 - (question_embedding <=> $5::vector) >= $6
        ORDER BY question_embedding <=> $5::vector
        LIMIT 1`,
      [
        key.businessId,
        key.locationId,
        key.businessDate,
        key.toolSignature,
        toVectorLiteral(questionEmbedding),
        threshold,
      ],
    );
    const row = rows[0];
    if (!row) return null;

    await query(`UPDATE ai_answer_cache SET hit_count = hit_count + 1 WHERE id = $1`, [row.id]);
    return {
      id: row.id,
      answer: row.answer,
      questionText: row.question_text,
      similarity: Number(row.similarity),
      hitCount: row.hit_count + 1,
      notice: CACHE_NOTICE,
    };
  } catch {
    // A cache failure must never be an answer failure.
    return null;
  }
}

/**
 * Stores a read-only answer. Refuses anything `isCacheableTurn` rejects — the
 * gate is here, not only at the call site, so a future caller cannot forget it.
 */
export async function storeCachedAnswer(
  key: CacheKey,
  input: {
    questionText: string;
    questionEmbedding: number[];
    answer: string;
    turn: TurnShape;
    ttlSeconds?: number;
  },
): Promise<boolean> {
  if (!isCacheableTurn(input.turn)) return false;
  if (!(await isAnswerCacheAvailable())) return false;
  const ttl = input.ttlSeconds ?? CACHE_TTL_SECONDS;

  try {
    await query(
      `INSERT INTO ai_answer_cache
         (business_id, location_id, question_embedding, question_text,
          business_date, tool_signature, answer, expires_at)
       VALUES ($1, $2, $3::vector, $4, $5, $6, $7, now() + ($8 || ' seconds')::interval)`,
      [
        key.businessId,
        key.locationId,
        toVectorLiteral(input.questionEmbedding),
        input.questionText,
        key.businessDate,
        key.toolSignature,
        input.answer,
        String(ttl),
      ],
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidates every cached answer whose signature covers `[from, to]`. Called
 * by the write paths — a new order, a payment, a stock movement, a ledger
 * entry, and crucially a sale posted onto an *earlier* day (an amendment, an
 * imported invoice), which is the case a naive "today's cache expires tonight"
 * scheme gets wrong.
 *
 * Done in SQL against the stored signature rather than in TypeScript so a
 * single statement covers whatever is in the table.
 */
export async function invalidateByRange(
  businessId: string,
  range: { from: string; to: string },
): Promise<number> {
  if (!(await isAnswerCacheAvailable())) return 0;
  try {
    const { rows } = await query<{ id: string; tool_signature: string }>(
      `SELECT id, tool_signature FROM ai_answer_cache WHERE business_id = $1`,
      [businessId],
    );
    const doomed = rows
      .filter((r) => signatureTouchesRange(r.tool_signature, range))
      .map((r) => r.id);
    if (doomed.length === 0) return 0;
    const { rowCount } = await query(
      `DELETE FROM ai_answer_cache WHERE business_id = $1 AND id = ANY($2::uuid[])`,
      [businessId, doomed],
    );
    return rowCount ?? 0;
  } catch {
    return 0;
  }
}

/** «خالی‌کردن کش» from `/dashboard/ai`. */
export async function clearCache(businessId: string): Promise<number> {
  if (!(await isAnswerCacheAvailable())) return 0;
  const { rowCount } = await query(`DELETE FROM ai_answer_cache WHERE business_id = $1`, [
    businessId,
  ]);
  return rowCount ?? 0;
}

/** Sweeps rows past their TTL. Cheap, and keeps the HNSW index honest. */
export async function sweepExpiredAnswers(businessId: string): Promise<number> {
  if (!(await isAnswerCacheAvailable())) return 0;
  const { rowCount } = await query(
    `DELETE FROM ai_answer_cache WHERE business_id = $1 AND expires_at <= now()`,
    [businessId],
  );
  return rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Write-path hook
// ---------------------------------------------------------------------------

/**
 * Normalises a tool-call date argument into the `YYYY-MM-DD` the signature
 * speaks, or null when it is absent/unparseable — null renders as `*` in the
 * signature, i.e. "no bound", which every write invalidates. Failing open to
 * *invalidation* rather than to *staleness* is the conservative direction.
 */
export function normalizeRangeDate(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1] : null;
}

/**
 * Invalidates cached answers whose signature covers the business's *current*
 * trading day — the hook a fresh order hangs off. `*..*` signatures (tools
 * called with no range, like a live stock valuation) are covered too, because
 * `signatureTouchesRange` treats an unbounded signature as touching every
 * write. Never throws; a silent 0 means "nothing to invalidate".
 */
export async function invalidateTodayForBusiness(businessId: string): Promise<number> {
  if (!(await isAnswerCacheAvailable())) return 0;
  try {
    const { rows } = await query<{ today: string }>(
      `SELECT app_business_date(
                now(),
                coalesce(l.timezone, 'Asia/Tehran'),
                l.business_day_start_minutes
              )::text AS today
         FROM (SELECT 1) one
         LEFT JOIN LATERAL (
           SELECT timezone, business_day_start_minutes
             FROM locations
            WHERE business_id = $1 AND is_active
            ORDER BY created_at
            LIMIT 1
         ) l ON true`,
      [businessId],
    );
    const today = rows[0]?.today;
    if (!today) return 0;
    return await invalidateByRange(businessId, { from: today, to: today });
  } catch {
    return 0;
  }
}
