/**
 * Phase D (unified entity model) — persistence and fact-gathering for the
 * Automation engine.
 *
 * The database half of `ai-automations.ts`: CRUD over `ai_automations`
 * (migration 0155), plus `gatherAutomationFacts` — the deterministic read of
 * the run-time facts a condition document is evaluated against — and
 * `previewAutomation`, a dry run that reports whether an automation's
 * conditions currently hold and what it would propose, WITHOUT proposing
 * anything. No provider call, no mutation path: an automation is configuration,
 * and firing it (later) reuses the same guarded executor the chat does.
 */
import { query } from "./db";
import { localBusinessClock, DEFAULT_PROACTIVE_TIMEZONE } from "./ai-proactive";
import { getArAging } from "./ar-service";
import { getApAging } from "./ap-service";
import {
  evaluateConditions,
  validateAutomation,
  type AutomationConditionDoc,
  type AutomationFacts,
  type AutomationInput,
  type AutomationApprovalMode,
  type AutomationEventKind,
  type AutomationTriggerKind,
} from "./ai-automations";
import type { ActionType } from "./ai";

export interface Automation {
  id: string;
  businessId: string;
  locationId: string | null;
  name: string;
  triggerKind: AutomationTriggerKind;
  eventKind: AutomationEventKind | null;
  scheduleHour: number | null;
  scheduleWeekday: number | null;
  conditions: AutomationConditionDoc;
  actionType: ActionType;
  actionPayload: Record<string, unknown>;
  approvalMode: AutomationApprovalMode;
  enabled: boolean;
  createdBy: string | null;
  authorizedBy: string | null;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

interface AutomationRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  name: string;
  trigger_kind: string;
  event_kind: string | null;
  schedule_hour: number | null;
  schedule_weekday: number | null;
  conditions: AutomationConditionDoc;
  action_type: string;
  action_payload: Record<string, unknown>;
  approval_mode: string;
  enabled: boolean;
  created_by: string | null;
  authorized_by: string | null;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
}

function toAutomation(row: AutomationRow): Automation {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    name: row.name,
    triggerKind: row.trigger_kind as AutomationTriggerKind,
    eventKind: row.event_kind as AutomationEventKind | null,
    scheduleHour: row.schedule_hour,
    scheduleWeekday: row.schedule_weekday,
    conditions: row.conditions ?? {},
    actionType: row.action_type as ActionType,
    actionPayload: row.action_payload ?? {},
    approvalMode: row.approval_mode as AutomationApprovalMode,
    enabled: row.enabled,
    createdBy: row.created_by,
    authorizedBy: row.authorized_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastRunAt: row.last_run_at ? row.last_run_at.toISOString() : null,
  };
}

const COLUMNS =
  "id, business_id, location_id, name, trigger_kind, event_kind, schedule_hour, schedule_weekday, conditions, action_type, action_payload, approval_mode, enabled, created_by, authorized_by, created_at, updated_at, last_run_at";

export type AutomationResult =
  | { ok: true; automation: Automation }
  | { ok: false; errors: string[] };

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

export async function listAutomations(businessId: string): Promise<Automation[]> {
  const { rows } = await query<AutomationRow>(
    `SELECT ${COLUMNS} FROM ai_automations WHERE business_id = $1 ORDER BY created_at DESC`,
    [businessId],
  );
  return rows.map(toAutomation);
}

export async function getAutomation(businessId: string, id: string): Promise<Automation | null> {
  const { rows } = await query<AutomationRow>(
    `SELECT ${COLUMNS} FROM ai_automations WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toAutomation(rows[0]) : null;
}

/**
 * `authorizedBy` is the human whose authority an unattended (`auto`) apply runs
 * under. The route sets it to the acting owner's id for an `auto` automation
 * and refuses `auto` without an owner, mirroring the coworker and autopilot.
 */
export async function createAutomation(
  businessId: string,
  input: AutomationInput,
  actor: { userId: string | null; authorizedBy: string | null },
): Promise<AutomationResult> {
  const validation = validateAutomation(input);
  if (!validation.ok) return validation;
  const v = validation.value;

  try {
    const { rows } = await query<AutomationRow>(
      `INSERT INTO ai_automations
         (business_id, location_id, name, trigger_kind, event_kind, schedule_hour, schedule_weekday,
          conditions, action_type, action_payload, approval_mode, enabled, created_by, authorized_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14)
       RETURNING ${COLUMNS}`,
      [
        businessId,
        v.locationId,
        v.name,
        v.triggerKind,
        v.eventKind,
        v.scheduleHour,
        v.scheduleWeekday,
        JSON.stringify(v.conditions),
        v.actionType,
        JSON.stringify(v.actionPayload),
        v.approvalMode,
        v.enabled,
        actor.userId,
        v.approvalMode === "auto" ? actor.authorizedBy : null,
      ],
    );
    return { ok: true, automation: toAutomation(rows[0]) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: ["name_taken"] };
    throw error;
  }
}

export async function updateAutomation(
  businessId: string,
  id: string,
  input: AutomationInput,
  actor: { authorizedBy: string | null },
): Promise<AutomationResult> {
  const validation = validateAutomation(input);
  if (!validation.ok) return validation;
  const v = validation.value;

  try {
    const { rows } = await query<AutomationRow>(
      `UPDATE ai_automations
          SET location_id = $3,
              name = $4,
              trigger_kind = $5,
              event_kind = $6,
              schedule_hour = $7,
              schedule_weekday = $8,
              conditions = $9::jsonb,
              action_type = $10,
              action_payload = $11::jsonb,
              approval_mode = $12,
              enabled = $13,
              authorized_by = $14,
              updated_at = now()
        WHERE business_id = $1 AND id = $2
        RETURNING ${COLUMNS}`,
      [
        businessId,
        id,
        v.locationId,
        v.name,
        v.triggerKind,
        v.eventKind,
        v.scheduleHour,
        v.scheduleWeekday,
        JSON.stringify(v.conditions),
        v.actionType,
        JSON.stringify(v.actionPayload),
        v.approvalMode,
        v.enabled,
        v.approvalMode === "auto" ? actor.authorizedBy : null,
      ],
    );
    if (!rows[0]) return { ok: false, errors: ["not_found"] };
    return { ok: true, automation: toAutomation(rows[0]) };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: ["name_taken"] };
    throw error;
  }
}

export async function deleteAutomation(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM ai_automations WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Facts + preview
// ---------------------------------------------------------------------------

async function businessTimezone(businessId: string): Promise<string> {
  const { rows } = await query<{ timezone: string | null }>(
    `SELECT timezone FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at LIMIT 1`,
    [businessId],
  );
  return rows[0]?.timezone || DEFAULT_PROACTIVE_TIMEZONE;
}

async function stockValuationTotalRial(businessId: string): Promise<number> {
  const { rows } = await query<{ total: string | null }>(
    `SELECT COALESCE(SUM(valuation), 0)::text AS total
       FROM v_inventory_valuation WHERE business_id = $1`,
    [businessId],
  );
  return Math.trunc(Number(rows[0]?.total ?? 0));
}

/**
 * Read the run-time facts a condition document is tested against. Every value
 * is a deterministic read of an existing report at call time — the same numbers
 * the chat's read tools would return — so an automation's decision is
 * reproducible and never depends on a stored, stale figure.
 */
export async function gatherAutomationFacts(
  businessId: string,
  now: Date = new Date(),
): Promise<AutomationFacts> {
  const [ar, ap, stock, timezone] = await Promise.all([
    getArAging(businessId),
    getApAging(businessId),
    stockValuationTotalRial(businessId),
    businessTimezone(businessId),
  ]);
  const clock = localBusinessClock(now, timezone);
  return {
    receivableTotalRial: Math.trunc(ar.totals.total),
    payableTotalRial: Math.trunc(ap.totals.total),
    stockValuationRial: stock,
    weekday: clock.weekday,
    hour: clock.hour,
  };
}

export interface AutomationPreview {
  facts: AutomationFacts;
  conditionsMet: boolean;
  actionType: ActionType;
  actionPayload: Record<string, unknown>;
}

/**
 * A dry run: gather the current facts, evaluate the automation's conditions and
 * report whether it WOULD propose its action right now — without proposing
 * anything. This is how the editor answers "would this fire today?".
 */
export async function previewAutomation(
  businessId: string,
  id: string,
  now: Date = new Date(),
): Promise<AutomationPreview | null> {
  const automation = await getAutomation(businessId, id);
  if (!automation) return null;
  const facts = await gatherAutomationFacts(businessId, now);
  return {
    facts,
    conditionsMet: evaluateConditions(automation.conditions, facts),
    actionType: automation.actionType,
    actionPayload: automation.actionPayload,
  };
}
