/**
 * The prompt manager — the two layers the assistant's system prompt is built
 * from, and the one door both layers are read through.
 *
 * Layer 1, platform (`ai_prompt_templates`, migration 0112): an active row
 * whose `fragment_key` is `surface:<mode>` **replaces** the code-built system
 * prompt for that surface entirely. The platform owns every surface the
 * assistant answers on — dashboard, floor, wizard, proactive, autopilot,
 * platform — and can re-engineer any of them without a deploy. The code
 * default in `buildSystemPrompt` stays the fallback: a missing or inactive row
 * must never silence the assistant.
 *
 * Layer 2, business (`ai_prompt_overrides`, migration 0115): a business
 * manager may append standing instructions for the surfaces they use
 * (dashboard / floor / wizard — `BUSINESS_PROMPT_SURFACES`). Appended, never
 * replacing: the confirm-before-write rules and the tool contract live in the
 * platform prompt, and a business must not be able to edit them away. This is
 * the "manage their own assistant" half.
 *
 * Both layers are cached briefly (`CACHE_TTL_MS`): a prompt is read on every
 * chat turn, an owner edits one a handful of times a year, and 15 seconds of
 * convergence is the right trade. Every read fails safe — on any error the
 * code default answers, exactly as before this module existed.
 */
import { buildSystemPrompt, type AgentMode, type PromptContext } from "./ai";
import { getPool, query } from "./db";

/** The surfaces a business may shape. Everything else is platform-only. */
export const BUSINESS_PROMPT_SURFACES = ["dashboard", "floor", "wizard"] as const;
export type BusinessPromptSurface = (typeof BUSINESS_PROMPT_SURFACES)[number];

/** Every surface the platform layer may author — "superadmin has all". */
export const PLATFORM_PROMPT_SURFACES: AgentMode[] = [
  "wizard",
  "dashboard",
  "floor",
  "proactive",
  "autopilot",
  "platform",
];

export function isBusinessPromptSurface(value: unknown): value is BusinessPromptSurface {
  return (
    typeof value === "string" &&
    (BUSINESS_PROMPT_SURFACES as readonly string[]).includes(value)
  );
}

/** A business instruction block has to stay short enough to read in one edit. */
export const MAX_BUSINESS_INSTRUCTIONS_CHARS = 4000;

/** How long a resolved layer is trusted before the next read refreshes it. */
export const CACHE_TTL_MS = 15_000;

/** `surface:dashboard` — the fragment key a platform row overrides. */
export function surfaceFragmentKey(mode: AgentMode): string {
  return `surface:${mode}`;
}

interface Cached<T> {
  at: number;
  value: T;
}

const platformCache = new Map<string, Cached<string | null>>();
const businessCache = new Map<string, Cached<string | null>>();
/** Monotonic clock test seam. */
const now: () => number = () => Date.now();

/** Test seam: forget every cached layer. */
export function resetPromptCaches(): void {
  platformCache.clear();
  businessCache.clear();
}

/**
 * The active platform prompt for a surface, or null when the code default
 * applies. Never throws — a read failure is "no override", and the assistant
 * keeps its built-in behaviour.
 */
export async function loadPlatformSurfacePrompt(mode: AgentMode): Promise<string | null> {
  const key = surfaceFragmentKey(mode);
  const cached = platformCache.get(key);
  if (cached && now() - cached.at < CACHE_TTL_MS) return cached.value;
  let value: string | null = null;
  try {
    const { rows } = await query<{ text: string }>(
      `SELECT text FROM ai_prompt_templates WHERE fragment_key = $1 AND is_active LIMIT 1`,
      [key],
    );
    value = rows[0]?.text?.trim() ? rows[0].text : null;
  } catch {
    value = null;
  }
  platformCache.set(key, { at: now(), value });
  return value;
}

/**
 * The business's active standing instructions for a surface, or null. Never
 * throws for the same reason: a layer that cannot be read is a layer that is
 * not applied, not a failed turn.
 */
export async function loadBusinessInstructions(
  businessId: string,
  surface: BusinessPromptSurface,
): Promise<string | null> {
  const key = `${businessId}|${surface}`;
  const cached = businessCache.get(key);
  if (cached && now() - cached.at < CACHE_TTL_MS) return cached.value;
  let value: string | null = null;
  try {
    const { rows } = await query<{ instructions: string }>(
      `SELECT instructions FROM ai_prompt_overrides
        WHERE business_id = $1 AND surface = $2 AND is_active LIMIT 1`,
      [businessId, surface],
    );
    value = rows[0]?.instructions?.trim() ? rows[0].instructions : null;
  } catch {
    value = null;
  }
  businessCache.set(key, { at: now(), value });
  return value;
}

/**
 * The system prompt for one turn: the platform layer (override or code
 * default), then the business layer appended under its own heading so the
 * model can tell platform rules from the owner's standing instructions apart.
 * Falls back to `buildSystemPrompt` unchanged on any failure.
 */
export async function resolveSystemPrompt(input: {
  mode: AgentMode;
  ctx: PromptContext;
  businessId?: string | null;
}): Promise<string> {
  const fallback = buildSystemPrompt(input.ctx);
  try {
    let prompt = (await loadPlatformSurfacePrompt(input.mode)) ?? fallback;
    if (input.businessId && isBusinessPromptSurface(input.mode)) {
      const instructions = await loadBusinessInstructions(
        input.businessId,
        input.mode,
      );
      if (instructions) {
        prompt = `${prompt}\n\nدستورالعمل دائمی مالک همین کسب‌وکار (همیشه رعایت کن، به‌جز وقتی با قواعد بالاتر تضاد دارد):\n${instructions}`;
      }
    }
    return prompt;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Business-layer writes (the platform layer is written through the platform
// prompts route, which version-stacks rows the way 0112 documents).
// ---------------------------------------------------------------------------

export interface BusinessPromptOverride {
  surface: BusinessPromptSurface;
  instructions: string;
  updatedAt: string | null;
}

/** The business's own prompt shapes, for the settings screen. */
export async function listBusinessOverrides(
  businessId: string,
): Promise<BusinessPromptOverride[]> {
  const { rows } = await query<{ surface: string; instructions: string; updated_at: string }>(
    `SELECT surface, instructions, updated_at
       FROM ai_prompt_overrides
      WHERE business_id = $1 AND is_active
      ORDER BY surface`,
    [businessId],
  );
  return rows
    .filter((row) => isBusinessPromptSurface(row.surface))
    .map((row) => ({
      surface: row.surface as BusinessPromptSurface,
      instructions: row.instructions,
      updatedAt: row.updated_at,
    }));
}

/**
 * Upserts the business's instruction block for one surface. Deactivating the
 * previous row and inserting the new one keeps the partial unique index honest
 * and leaves the edit trail in the table.
 */
export async function saveBusinessOverride(input: {
  businessId: string;
  surface: BusinessPromptSurface;
  instructions: string;
  updatedBy: string;
}): Promise<void> {
  const instructions = input.instructions.trim();
  if (!instructions) throw new Error("empty_instructions");
  if (instructions.length > MAX_BUSINESS_INSTRUCTIONS_CHARS) throw new Error("too_long");

  await query(
    `UPDATE ai_prompt_overrides SET is_active = false, updated_at = now()
      WHERE business_id = $1 AND surface = $2 AND is_active`,
    [input.businessId, input.surface],
  );
  await query(
    `INSERT INTO ai_prompt_overrides (business_id, surface, instructions, is_active, updated_by)
     VALUES ($1, $2, $3, true, $4)`,
    [input.businessId, input.surface, instructions, input.updatedBy],
  );
  businessCache.delete(`${input.businessId}|${input.surface}`);
}

/** Removes the business's instruction block for one surface. */
export async function deleteBusinessOverride(
  businessId: string,
  surface: BusinessPromptSurface,
): Promise<void> {
  await query(
    `UPDATE ai_prompt_overrides SET is_active = false, updated_at = now()
      WHERE business_id = $1 AND surface = $2 AND is_active`,
    [businessId, surface],
  );
  businessCache.delete(`${businessId}|${surface}`);
}

// ---------------------------------------------------------------------------
// Platform-layer writes. Version-stacked like 0112 documents: saving a new
// prompt inserts a new version row and moves the active flag to it, so the
// previous wording is one query away when an edit made things worse.
// ---------------------------------------------------------------------------

export interface PlatformPromptSurfaceState {
  mode: AgentMode;
  fragmentKey: string;
  /** The active override text, or null when the code default applies. */
  activeText: string | null;
  activeVersion: number | null;
  versions: { id: string; version: number; isActive: boolean; createdAt: string }[];
}

/** Every surface with its active prompt and version history. */
export async function listPlatformPromptSurfaces(): Promise<PlatformPromptSurfaceState[]> {
  const { rows } = await query<{
    fragment_key: string;
    id: string;
    version: number;
    text: string;
    is_active: boolean;
    created_at: string;
  }>(
    `SELECT fragment_key, id, version, text, is_active, created_at
       FROM ai_prompt_templates
      WHERE fragment_key LIKE 'surface:%'
      ORDER BY fragment_key, version DESC`,
  );
  const states = new Map<string, PlatformPromptSurfaceState>();
  for (const mode of PLATFORM_PROMPT_SURFACES) {
    states.set(surfaceFragmentKey(mode), {
      mode,
      fragmentKey: surfaceFragmentKey(mode),
      activeText: null,
      activeVersion: null,
      versions: [],
    });
  }
  for (const row of rows) {
    const state = states.get(row.fragment_key);
    if (!state) continue;
    state.versions.push({
      id: row.id,
      version: row.version,
      isActive: row.is_active,
      createdAt: row.created_at,
    });
    if (row.is_active) {
      state.activeText = row.text;
      state.activeVersion = row.version;
    }
  }
  return [...states.values()];
}

/** Saves a new active version of a surface prompt. */
export async function savePlatformSurfacePrompt(input: {
  mode: AgentMode;
  text: string;
  createdBy: string;
}): Promise<void> {
  const text = input.text.trim();
  if (!text) throw new Error("empty_prompt");
  const fragmentKey = surfaceFragmentKey(input.mode);
  // A dedicated client, because the deactivate→version→activate sequence is
  // one transaction over one connection — `query` above is pool-scoped.
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE ai_prompt_templates SET is_active = false WHERE fragment_key = $1 AND is_active`,
      [fragmentKey],
    );
    const { rows } = await client.query<{ next: string }>(
      `SELECT coalesce(max(version), 0) + 1 AS next FROM ai_prompt_templates WHERE fragment_key = $1`,
      [fragmentKey],
    );
    await client.query(
      `INSERT INTO ai_prompt_templates (fragment_key, version, text, is_active, created_by)
       VALUES ($1, $2, $3, true, $4)`,
      [fragmentKey, Number(rows[0]?.next ?? 1), text, input.createdBy],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  platformCache.delete(fragmentKey);
}

/** Drops the active override — the surface falls back to its code default. */
export async function clearPlatformSurfacePrompt(mode: AgentMode): Promise<void> {
  const fragmentKey = surfaceFragmentKey(mode);
  await query(
    `UPDATE ai_prompt_templates SET is_active = false WHERE fragment_key = $1 AND is_active`,
    [fragmentKey],
  );
  platformCache.delete(fragmentKey);
}
