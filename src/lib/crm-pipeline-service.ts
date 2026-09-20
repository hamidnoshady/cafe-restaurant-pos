/**
 * Configurable sales pipelines and stages.
 *
 * ## What this replaces
 *
 * Stages used to be a `CHECK` constraint listing six strings. That works until
 * the first business says "we have a site-visit stage", at which point the
 * options are a migration per customer or nothing. Stages are now rows.
 *
 * The old `crm_deals.stage` **text column still exists and is still written**.
 * That is deliberate, not laziness: every pre-0157 query reads it, persisted
 * filters and saved reports name it, and dropping it to satisfy tidiness would
 * be a destructive change with no user-visible benefit. `stage_id` is the truth
 * for new code; `stage` is kept in step by `legacyStageKey` below so both
 * readers agree.
 *
 * ## Outcome, not name
 *
 * Reporting keys on `outcome` (`open` / `won` / `lost`), never on a stage's
 * name. A business renaming «برنده» to «قرارداد نهایی شد» keeps its win rate,
 * and a business with three different "lost" stages (lost to price, lost to a
 * competitor, went quiet) gets them all counted as losses.
 *
 * ## Won posts nothing
 *
 * Moving a deal to a `won` stage writes no journal line, no invoice and no
 * order. A pipeline is a *forecast*; revenue exists when there is a sales
 * document. Wiring "won" to the ledger would let anyone with CRM access
 * fabricate revenue by dragging a card, and would double-count the moment the
 * real invoice was issued. The handoff is explicit and separate — see
 * `crm-deal-handoff.ts`.
 */

import { query, withTenant, withTenantTransaction } from "./db";
import { recordCrmAudit } from "./crm-audit-service";
import { isUuid } from "./uuid";

export type StageOutcome = "open" | "won" | "lost";

export interface PipelineStage extends Record<string, unknown> {
  id: string;
  pipelineId: string;
  name: string;
  legacyKey: string | null;
  displayOrder: number;
  defaultProbability: number;
  outcome: StageOutcome;
  isActive: boolean;
  requirementNote: string;
}

/**
 * A pipeline without its stages — the row shape as it comes back from SQL.
 * Split out because `Omit<Pipeline, "stages">` over a type carrying an index
 * signature erases the named fields along with the omitted one.
 */
export interface PipelineRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  displayOrder: number;
  archivedAt: string | null;
}

export interface Pipeline extends PipelineRow {
  stages: PipelineStage[];
}

const STAGE_COLUMNS = `id, pipeline_id AS "pipelineId", name, legacy_key AS "legacyKey",
  display_order AS "displayOrder", default_probability AS "defaultProbability",
  outcome, is_active AS "isActive", requirement_note AS "requirementNote"`;

/**
 * Every pipeline with its stages, in one round trip.
 *
 * Two queries rather than a join with a row per stage: the board renders
 * pipelines and stages as separate structures anyway, and a join here would
 * repeat each pipeline's fields once per stage for no benefit.
 */
export async function listPipelines(
  businessId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Pipeline[]> {
  const { rows: pipelines } = await query<PipelineRow>(
    `SELECT id, name, description, is_default AS "isDefault",
            display_order AS "displayOrder", archived_at AS "archivedAt"
       FROM crm_pipelines
      WHERE business_id = $1 ${options.includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY is_default DESC, display_order, name`,
    [businessId],
  );
  if (pipelines.length === 0) return [];

  const { rows: stages } = await query<PipelineStage>(
    `SELECT ${STAGE_COLUMNS} FROM crm_pipeline_stages
      WHERE business_id = $1 AND pipeline_id = ANY($2::uuid[])
      ORDER BY display_order, name`,
    [businessId, pipelines.map((pipeline) => pipeline.id)],
  );

  const byPipeline = new Map<string, PipelineStage[]>();
  for (const stage of stages) {
    const list = byPipeline.get(stage.pipelineId) ?? [];
    list.push(stage);
    byPipeline.set(stage.pipelineId, list);
  }
  return pipelines.map((pipeline) => ({ ...pipeline, stages: byPipeline.get(pipeline.id) ?? [] }));
}

/**
 * The stages every business starts with.
 *
 * The same six the pre-0157 `CHECK` constraint allowed, with the same
 * `legacy_key` values, so a freshly provisioned business and an upgraded one
 * have structurally identical pipelines. Anything else would mean two code
 * paths to test and a subtle difference nobody notices until a report
 * disagrees between two tenants.
 */
const SEED_STAGES: readonly {
  name: string;
  legacyKey: string;
  displayOrder: number;
  probability: number;
  outcome: StageOutcome;
}[] = [
  { name: "سرنخ", legacyKey: "lead", displayOrder: 1, probability: 10, outcome: "open" },
  { name: "واجد شرایط", legacyKey: "qualified", displayOrder: 2, probability: 30, outcome: "open" },
  { name: "پیشنهاد", legacyKey: "proposal", displayOrder: 3, probability: 55, outcome: "open" },
  { name: "مذاکره", legacyKey: "negotiation", displayOrder: 4, probability: 75, outcome: "open" },
  { name: "برنده", legacyKey: "won", displayOrder: 5, probability: 100, outcome: "won" },
  { name: "بازنده", legacyKey: "lost", displayOrder: 6, probability: 0, outcome: "lost" },
];

/**
 * The pipeline a new deal lands in, creating the default one if it is missing.
 *
 * ## Why this self-heals rather than trusting provisioning
 *
 * Migration 0157 seeds a pipeline for every business that existed when it ran.
 * Businesses created *afterwards* get one only if every provisioning path
 * remembers to — and there are three of them (`business-provisioning`,
 * `pairing-apply`, `platform-service`), with nothing stopping a fourth. A
 * business with no pipeline cannot open the deals board at all, which is a
 * total failure of the feature caused by an omission nobody would notice until
 * a customer reported it.
 *
 * So the read path creates what it needs. `ON CONFLICT DO NOTHING` against the
 * `(business_id, name)` unique constraint makes it safe under concurrency: two
 * simultaneous first-loads produce one pipeline, not two, and the loser of the
 * race simply reads what the winner wrote.
 */
export async function defaultPipeline(businessId: string): Promise<Pipeline | null> {
  const existing = await listPipelines(businessId);
  const found = existing.find((pipeline) => pipeline.isDefault) ?? existing[0];
  // A pipeline with no stages is as unusable as no pipeline — seed those too,
  // rather than handing the board an empty column list.
  if (found && found.stages.length > 0) return found;

  return withTenant(businessId, async () => {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_pipelines (business_id, name, description, is_default, display_order, created_by)
       VALUES ($1, 'قیف فروش پیش‌فرض', 'مراحل استاندارد فروش', true, 0, 'system')
       ON CONFLICT (business_id, name) DO NOTHING
       RETURNING id`,
      [businessId],
    );
    // No row back means another request won the race (or the pipeline existed
    // but had no stages); either way, read the id rather than failing.
    let pipelineId = rows[0]?.id;
    if (!pipelineId) {
      const { rows: again } = await query<{ id: string }>(
        `SELECT id FROM crm_pipelines
          WHERE business_id = $1 AND archived_at IS NULL
          ORDER BY is_default DESC, display_order LIMIT 1`,
        [businessId],
      );
      pipelineId = again[0]?.id;
      if (!pipelineId) return null;
    }

    for (const stage of SEED_STAGES) {
      await query(
        `INSERT INTO crm_pipeline_stages
           (business_id, pipeline_id, name, legacy_key, display_order, default_probability, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (pipeline_id, name) DO NOTHING`,
        [
          businessId,
          pipelineId,
          stage.name,
          stage.legacyKey,
          stage.displayOrder,
          stage.probability,
          stage.outcome,
        ],
      );
    }

    const seeded = await listPipelines(businessId);
    return seeded.find((pipeline) => pipeline.id === pipelineId) ?? null;
  });
}

export async function getStage(businessId: string, stageId: string): Promise<PipelineStage | null> {
  if (!isUuid(stageId)) return null;
  const { rows } = await query<PipelineStage>(
    `SELECT ${STAGE_COLUMNS} FROM crm_pipeline_stages WHERE business_id = $1 AND id = $2`,
    [businessId, stageId],
  );
  return rows[0] ?? null;
}

/**
 * The value to write into the legacy `crm_deals.stage` text column.
 *
 * A seeded stage carries the exact string the old CHECK allowed. A stage a
 * business invented has no legacy equivalent, so it reports its *outcome* —
 * `open` collapses to `lead`, which is the only honest answer the old
 * vocabulary can give about a custom stage. The alternative, writing the
 * custom name, would break every consumer that still compares against the six
 * known strings.
 */
export function legacyStageKey(stage: Pick<PipelineStage, "legacyKey" | "outcome">): string {
  if (stage.legacyKey) return stage.legacyKey;
  if (stage.outcome === "won") return "won";
  if (stage.outcome === "lost") return "lost";
  return "lead";
}

export interface SaveStageInput {
  id?: string;
  name: string;
  displayOrder?: number;
  defaultProbability?: number;
  outcome?: StageOutcome;
  isActive?: boolean;
  requirementNote?: string;
}

/**
 * Replace a pipeline's stage list in one transaction.
 *
 * Whole-list rather than per-stage, because ordering is a property of the set:
 * saving stages one at a time means the board is briefly in an order nobody
 * chose, and two people reordering at once interleave into nonsense.
 *
 * ## The rules that protect existing deals
 *
 * - A stage that still holds deals **cannot be deleted**. Deleting it would
 *   leave those deals stageless — invisible on every board, excluded from
 *   every forecast, and discoverable only by someone querying SQL. Deactivate
 *   instead: the stage stops being offered but its deals stay where they are.
 * - A pipeline must keep at least one `open` stage and at least one `won`
 *   stage. Without an open stage no deal can be created; without a won stage a
 *   deal can never be closed successfully and the win rate is structurally
 *   zero.
 */
export async function savePipelineStages(
  businessId: string,
  pipelineId: string,
  stages: SaveStageInput[],
  actor: { name: string; userId?: string | null },
): Promise<{ pipeline: Pipeline | null; error?: string }> {
  if (!isUuid(pipelineId)) return { pipeline: null, error: "not_found" };

  const cleaned = stages
    .map((stage, index) => ({
      id: stage.id && isUuid(stage.id) ? stage.id : undefined,
      name: stage.name.trim(),
      displayOrder: Number.isFinite(stage.displayOrder) ? Number(stage.displayOrder) : index + 1,
      defaultProbability: Math.min(Math.max(Math.round(stage.defaultProbability ?? 0), 0), 100),
      outcome: (["open", "won", "lost"] as const).includes(stage.outcome as StageOutcome)
        ? (stage.outcome as StageOutcome)
        : ("open" as StageOutcome),
      isActive: stage.isActive !== false,
      requirementNote: (stage.requirementNote ?? "").trim().slice(0, 300),
    }))
    .filter((stage) => stage.name.length > 0);

  if (cleaned.length === 0) return { pipeline: null, error: "stages_required" };
  if (!cleaned.some((stage) => stage.outcome === "open")) {
    return { pipeline: null, error: "open_stage_required" };
  }
  if (!cleaned.some((stage) => stage.outcome === "won")) {
    return { pipeline: null, error: "won_stage_required" };
  }
  // Two stages with one name make the board ambiguous and the unique index
  // would reject it anyway — catching it here gives a usable error instead of
  // a constraint violation.
  const names = cleaned.map((stage) => stage.name);
  if (new Set(names).size !== names.length) return { pipeline: null, error: "duplicate_stage_name" };

  // Transactional: the stage list is read FOR UPDATE and then rewritten, so
  // two people reordering at once must not interleave into a board neither of
  // them chose.
  const result = await withTenantTransaction(businessId, async () => {
    const { rows: existing } = await query<{ id: string; name: string; legacy_key: string | null }>(
      `SELECT id, name, legacy_key FROM crm_pipeline_stages
        WHERE business_id = $1 AND pipeline_id = $2 FOR UPDATE`,
      [businessId, pipelineId],
    );
    if (existing.length === 0) {
      const { rows: owned } = await query<{ id: string }>(
        `SELECT id FROM crm_pipelines WHERE business_id = $1 AND id = $2`,
        [businessId, pipelineId],
      );
      if (!owned[0]) return { error: "not_found" as const };
    }

    const keptIds = new Set(cleaned.map((stage) => stage.id).filter(Boolean) as string[]);
    const removed = existing.filter((stage) => !keptIds.has(stage.id));

    if (removed.length > 0) {
      const { rows: inUse } = await query<{ stage_id: string; count: string }>(
        `SELECT stage_id, count(*)::text AS count FROM crm_deals
          WHERE business_id = $1 AND stage_id = ANY($2::uuid[])
          GROUP BY stage_id`,
        [businessId, removed.map((stage) => stage.id)],
      );
      if (inUse.length > 0) {
        const blocking = removed
          .filter((stage) => inUse.some((row) => row.stage_id === stage.id))
          .map((stage) => stage.name);
        return { error: "stage_in_use" as const, blocking };
      }
      await query(
        `DELETE FROM crm_pipeline_stages WHERE business_id = $1 AND id = ANY($2::uuid[])`,
        [businessId, removed.map((stage) => stage.id)],
      );
    }

    for (const stage of cleaned) {
      if (stage.id && existing.some((row) => row.id === stage.id)) {
        await query(
          `UPDATE crm_pipeline_stages
              SET name = $3, display_order = $4, default_probability = $5,
                  outcome = $6, is_active = $7, requirement_note = $8, updated_at = now()
            WHERE business_id = $1 AND id = $2`,
          [
            businessId,
            stage.id,
            stage.name,
            stage.displayOrder,
            stage.defaultProbability,
            stage.outcome,
            stage.isActive,
            stage.requirementNote,
          ],
        );
      } else {
        await query(
          `INSERT INTO crm_pipeline_stages
             (business_id, pipeline_id, name, display_order, default_probability,
              outcome, is_active, requirement_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            businessId,
            pipelineId,
            stage.name,
            stage.displayOrder,
            stage.defaultProbability,
            stage.outcome,
            stage.isActive,
            stage.requirementNote,
          ],
        );
      }
    }
    return { error: undefined };
  });

  if (result.error) return { pipeline: null, error: result.error };

  await recordCrmAudit({
    businessId,
    kind: "deal.stage_changed",
    entityType: "deal",
    entityId: pipelineId,
    summary: "مراحل قیف فروش تغییر کرد",
    detail: { pipelineId, stages: cleaned.map((stage) => stage.name) },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });

  const pipelines = await listPipelines(businessId, { includeArchived: true });
  return { pipeline: pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null };
}

export interface StageMoveResult {
  ok: boolean;
  error?: "not_found" | "stage_not_found" | "same_stage";
  /** Seconds the deal spent in the stage it just left — null on first entry. */
  secondsInPreviousStage?: number | null;
}

/**
 * Move a deal to a stage, recording the transition.
 *
 * Every move writes a `crm_deal_stage_history` row: from, to, who, when, and
 * how long the deal sat where it was. Recorded rather than derived, because
 * the *sequence* is what velocity reporting needs and a current-state column
 * cannot reconstruct a path. It also answers the question a sales manager
 * actually asks — "where do deals stall?" — which no snapshot can.
 *
 * Stage names are snapshotted onto the history row alongside the ids, so the
 * history stays readable after a stage is renamed or archived.
 *
 * **Writes nothing to the ledger, on any stage, including won.** See the file
 * comment.
 */
export async function moveDealToStage(
  businessId: string,
  dealId: string,
  stageId: string,
  actor: { name: string; userId?: string | null },
  options: { note?: string; lostReason?: string; wonReason?: string } = {},
): Promise<StageMoveResult> {
  if (!isUuid(dealId) || !isUuid(stageId)) return { ok: false, error: "not_found" };

  // The deal is locked, read, updated and given a history row — all or
  // nothing, and the lock has to survive between those statements.
  return withTenantTransaction(businessId, async () => {
    const { rows: dealRows } = await query<{
      id: string;
      stage_id: string | null;
      stage_entered_at: string | null;
      customer_id: string | null;
      title: string;
      pipeline_id: string | null;
    }>(
      `SELECT id, stage_id, stage_entered_at, customer_id, title, pipeline_id
         FROM crm_deals WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, dealId],
    );
    const deal = dealRows[0];
    if (!deal) return { ok: false, error: "not_found" as const };

    const target = await getStage(businessId, stageId);
    if (!target) return { ok: false, error: "stage_not_found" as const };
    // Moving a deal onto the stage it is already in is a no-op, not an error
    // worth surfacing — but it must not write a history row, or a board that
    // re-saves on every render would bury the real transitions.
    if (deal.stage_id === stageId) return { ok: true, secondsInPreviousStage: null };

    const previous = deal.stage_id ? await getStage(businessId, deal.stage_id) : null;
    const secondsInPrevious = deal.stage_entered_at
      ? Math.max(0, Math.round((Date.now() - new Date(deal.stage_entered_at).getTime()) / 1000))
      : null;

    const terminal = target.outcome !== "open";
    await query(
      `UPDATE crm_deals
          SET stage_id = $3,
              pipeline_id = COALESCE(pipeline_id, $4),
              stage = $5,
              stage_entered_at = now(),
              last_activity_at = now(),
              lost_reason = CASE WHEN $6 = 'lost' THEN $7 ELSE NULL END,
              won_reason = CASE WHEN $6 = 'won' THEN $8 ELSE NULL END,
              closed_at = CASE WHEN $9 THEN COALESCE(closed_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        dealId,
        stageId,
        target.pipelineId,
        // Keep the legacy text column in step — see legacyStageKey.
        legacyStageKey(target),
        target.outcome,
        options.lostReason?.trim() || null,
        options.wonReason?.trim() || null,
        terminal,
      ],
    );

    await query(
      `INSERT INTO crm_deal_stage_history
         (business_id, deal_id, from_stage_id, to_stage_id, from_stage_name, to_stage_name,
          seconds_in_from_stage, changed_by_id, changed_by, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        businessId,
        dealId,
        previous?.id ?? null,
        target.id,
        previous?.name ?? "",
        target.name,
        secondsInPrevious,
        actor.userId ?? null,
        actor.name,
        options.note?.trim() ?? "",
      ],
    );

    await recordCrmAudit({
      businessId,
      kind: "deal.stage_changed",
      entityType: "deal",
      entityId: dealId,
      partyId: deal.customer_id,
      summary: `«${deal.title}» به مرحلهٔ «${target.name}» رفت`,
      detail: {
        from: previous?.name ?? null,
        to: target.name,
        outcome: target.outcome,
        secondsInPreviousStage: secondsInPrevious,
        // Stated explicitly in the audit trail so an auditor reading it can
        // see that winning a deal moved no money.
        postedToLedger: false,
      },
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
    });

    return { ok: true, secondsInPreviousStage: secondsInPrevious };
  });
}

export interface StageHistoryEntry extends Record<string, unknown> {
  id: string;
  fromStageName: string;
  toStageName: string;
  secondsInFromStage: number | null;
  changedBy: string;
  note: string;
  createdAt: string;
}

/** One deal's stage history, oldest first — it reads as a story. */
export async function dealStageHistory(
  businessId: string,
  dealId: string,
): Promise<StageHistoryEntry[]> {
  if (!isUuid(dealId)) return [];
  const { rows } = await query<StageHistoryEntry>(
    `SELECT id, from_stage_name AS "fromStageName", to_stage_name AS "toStageName",
            seconds_in_from_stage AS "secondsInFromStage", changed_by AS "changedBy",
            note, created_at AS "createdAt"
       FROM crm_deal_stage_history
      WHERE business_id = $1 AND deal_id = $2
      ORDER BY created_at, id`,
    [businessId, dealId],
  );
  return rows.map((row) => ({
    ...row,
    secondsInFromStage: row.secondsInFromStage === null ? null : Number(row.secondsInFromStage),
  }));
}

export interface StageVelocity {
  stageId: string;
  stageName: string;
  outcome: StageOutcome;
  /** Deals currently sitting here. */
  openCount: number;
  openValueRial: number;
  /** Median seconds deals historically spent here before moving on. */
  medianSeconds: number | null;
  /** Deals that have been here longer than the median — the stalled ones. */
  stalledCount: number;
}

/**
 * Where deals sit and where they stall.
 *
 * Median rather than mean: one deal that sat in «مذاکره» for eight months
 * drags an average far enough to make the number useless, and pipeline dwell
 * times are exactly the kind of long-tailed distribution where that happens.
 */
export async function pipelineVelocity(
  businessId: string,
  pipelineId: string,
): Promise<StageVelocity[]> {
  if (!isUuid(pipelineId)) return [];
  const { rows } = await query<{
    stage_id: string;
    stage_name: string;
    outcome: StageOutcome;
    open_count: string;
    open_value: string;
    median_seconds: string | null;
    stalled_count: string;
  }>(
    `WITH stage AS (
        SELECT id, name, outcome FROM crm_pipeline_stages
         WHERE business_id = $1 AND pipeline_id = $2
    ),
    live AS (
        SELECT d.stage_id,
               count(*)::text AS open_count,
               COALESCE(sum(d.value_rial), 0)::text AS open_value
          FROM crm_deals d
         WHERE d.business_id = $1 AND d.pipeline_id = $2 AND d.closed_at IS NULL
         GROUP BY d.stage_id
    ),
    dwell AS (
        SELECT h.from_stage_id AS stage_id,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY h.seconds_in_from_stage) AS median_seconds
          FROM crm_deal_stage_history h
         WHERE h.business_id = $1 AND h.seconds_in_from_stage IS NOT NULL
         GROUP BY h.from_stage_id
    ),
    stalled AS (
        SELECT d.stage_id, count(*)::text AS stalled_count
          FROM crm_deals d
          JOIN dwell ON dwell.stage_id = d.stage_id
         WHERE d.business_id = $1 AND d.pipeline_id = $2 AND d.closed_at IS NULL
           AND d.stage_entered_at IS NOT NULL
           AND EXTRACT(EPOCH FROM (now() - d.stage_entered_at)) > dwell.median_seconds
         GROUP BY d.stage_id
    )
    SELECT s.id AS stage_id, s.name AS stage_name, s.outcome,
           COALESCE(live.open_count, '0') AS open_count,
           COALESCE(live.open_value, '0') AS open_value,
           dwell.median_seconds::text AS median_seconds,
           COALESCE(stalled.stalled_count, '0') AS stalled_count
      FROM stage s
      LEFT JOIN live ON live.stage_id = s.id
      LEFT JOIN dwell ON dwell.stage_id = s.id
      LEFT JOIN stalled ON stalled.stage_id = s.id
     ORDER BY s.id`,
    [businessId, pipelineId],
  );

  return rows.map((row) => ({
    stageId: row.stage_id,
    stageName: row.stage_name,
    outcome: row.outcome,
    openCount: Number(row.open_count),
    openValueRial: Number(row.open_value),
    medianSeconds: row.median_seconds === null ? null : Math.round(Number(row.median_seconds)),
    stalledCount: Number(row.stalled_count),
  }));
}
