/**
 * Phase D (unified entity model) — the pure core of the Automation engine.
 *
 * An automation is a free composition an owner assembles themselves:
 *     WHEN  <trigger>      (manual | schedule | event)
 *     IF    <conditions>   (a typed rule document over run-time facts)
 *     THEN  <action>       (one ACTION_CATALOG action + payload)
 *
 * The coworker (ai-coworker.ts) fills a fixed template; an automation lets the
 * owner pick the trigger, the condition and the action independently. What it
 * adds over everything before it is the CONDITION: a typed, deterministic rule
 * document evaluated against facts read from the database at fire time.
 *
 * Everything here is framework-free — no DB, no provider, no `next/*` — so the
 * validation and the evaluator can be unit-tested in isolation and reused by
 * both the HTTP route (on write) and, later, the tick (on fire). Persistence
 * and fact-gathering live in `ai-automations-service.ts`.
 *
 * Two safety properties, mirrored from the coworker and enforced here + in the
 * route:
 *   * `actionType` is validated against the LIVE `ACTION_CATALOG` (minus
 *     coworker-only actions), so an automation opens no new mutation path — it
 *     proposes exactly what the chat could, through the same guarded executor.
 *   * The condition document is validated field-by-field; an unknown field or
 *     operator is rejected, never ignored, so an automation that looks scoped
 *     cannot silently match everything.
 */
import { ACTION_CATALOG, isKnownAction, type ActionType } from "./ai";
import {
  COWORKER_EVENT_KINDS,
  COWORKER_TRIGGER_KINDS,
  isCoworkerEventKind,
  isCoworkerTriggerKind,
  type CoworkerApprovalMode,
  type CoworkerEventKind,
  type CoworkerTriggerKind,
} from "./ai-coworker";

export const MAX_AUTOMATION_NAME = 120;
export const MAX_AUTOMATION_CONDITIONS = 10;

// The trigger vocabulary is shared with the coworker on purpose (see the
// migration): one tick can drive both later without a schema change.
export const AUTOMATION_TRIGGER_KINDS = COWORKER_TRIGGER_KINDS;
export type AutomationTriggerKind = CoworkerTriggerKind;
export const AUTOMATION_EVENT_KINDS = COWORKER_EVENT_KINDS.filter((kind) =>
  ["shift_open", "shift_close", "day_close"].includes(kind),
) as readonly CoworkerEventKind[];
export type AutomationEventKind = "shift_open" | "shift_close" | "day_close";
export type AutomationApprovalMode = CoworkerApprovalMode;

// ---------------------------------------------------------------------------
// Conditions — a typed rule document over run-time facts
// ---------------------------------------------------------------------------

/**
 * The facts an automation can test. Each is a single non-negative integer Rial
 * amount or a small bounded number, read deterministically from the database at
 * fire time by the service. Kept deliberately small: a condition is a gate, not
 * a query language, and every field here maps to one existing report.
 */
export const AUTOMATION_FIELDS = [
  "receivableTotalRial", // total outstanding A/R (getArAging totals.total)
  "payableTotalRial", // total outstanding A/P (getApAging totals.total)
  "stockValuationRial", // current inventory valuation total
  "weekday", // 0..6 (Saturday..Friday, the business-clock convention)
  "hour", // 0..23, the business-clock hour at fire time
] as const;
export type AutomationField = (typeof AUTOMATION_FIELDS)[number];

export const AUTOMATION_FIELD_LABELS: Record<AutomationField, string> = {
  receivableTotalRial: "مجموع مطالبات از مشتریان",
  payableTotalRial: "مجموع بدهی به تأمین‌کنندگان",
  stockValuationRial: "ارزش کل موجودی انبار",
  weekday: "روز هفته",
  hour: "ساعت",
};

export const AUTOMATION_OPERATORS = ["gte", "lte", "eq"] as const;
export type AutomationOperator = (typeof AUTOMATION_OPERATORS)[number];

export interface AutomationCondition {
  field: AutomationField;
  op: AutomationOperator;
  value: number;
}

/** `all` is AND, `any` is OR; an empty document always matches. */
export interface AutomationConditionDoc {
  all?: AutomationCondition[];
  any?: AutomationCondition[];
}

/** The facts a run supplies to the evaluator. Every field is required so a
 * missing fact reads as a bug, not a silently-skipped condition. */
export type AutomationFacts = Record<AutomationField, number>;

export function isAutomationField(value: unknown): value is AutomationField {
  return typeof value === "string" && (AUTOMATION_FIELDS as readonly string[]).includes(value);
}

export function isAutomationOperator(value: unknown): value is AutomationOperator {
  return typeof value === "string" && (AUTOMATION_OPERATORS as readonly string[]).includes(value);
}

function evalOne(condition: AutomationCondition, facts: AutomationFacts): boolean {
  const actual = facts[condition.field];
  switch (condition.op) {
    case "gte":
      return actual >= condition.value;
    case "lte":
      return actual <= condition.value;
    case "eq":
      return actual === condition.value;
  }
}

/**
 * Deterministically evaluate a condition document against facts. Empty ⇒ true
 * (the automation fires whenever its trigger does). `all` must all hold; `any`
 * needs at least one; a document with both needs all-of AND any-of.
 */
export function evaluateConditions(doc: AutomationConditionDoc, facts: AutomationFacts): boolean {
  const all = doc.all ?? [];
  const any = doc.any ?? [];
  if (all.length === 0 && any.length === 0) return true;
  const allHold = all.every((c) => evalOne(c, facts));
  const anyHold = any.length === 0 ? true : any.some((c) => evalOne(c, facts));
  return allHold && anyHold;
}

// ---------------------------------------------------------------------------
// Automation definition + validation
// ---------------------------------------------------------------------------

export interface AutomationInput {
  name?: unknown;
  locationId?: unknown;
  projectId?: unknown;
  triggerKind?: unknown;
  eventKind?: unknown;
  scheduleHour?: unknown;
  scheduleWeekday?: unknown;
  conditions?: unknown;
  actionType?: unknown;
  actionPayload?: unknown;
  approvalMode?: unknown;
  enabled?: unknown;
}

export interface NormalizedAutomation {
  name: string;
  locationId: string | null;
  projectId: string | null;
  triggerKind: AutomationTriggerKind;
  eventKind: AutomationEventKind | null;
  scheduleHour: number | null;
  scheduleWeekday: number | null;
  conditions: AutomationConditionDoc;
  actionType: ActionType;
  actionPayload: Record<string, unknown>;
  approvalMode: AutomationApprovalMode;
  enabled: boolean;
}

export type AutomationValidation =
  | { ok: true; value: NormalizedAutomation }
  | { ok: false; errors: string[] };

/** The actions an automation may propose — the same boundary a custom agent
 * and the MCP writes draw: the whole catalogue minus the coworker-only ones. */
export function selectableAutomationActions(): ActionType[] {
  return (Object.keys(ACTION_CATALOG) as ActionType[]).filter(
    (type) => !ACTION_CATALOG[type].coworkerOnly,
  );
}

function normalizeConditionList(raw: unknown, errors: string[], side: string): AutomationCondition[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`conditions_${side}_invalid`);
    return [];
  }
  const out: AutomationCondition[] = [];
  for (const entry of raw) {
    const obj = (entry ?? {}) as Record<string, unknown>;
    if (!isAutomationField(obj.field)) {
      errors.push(`unknown_field:${String(obj.field)}`);
      continue;
    }
    if (!isAutomationOperator(obj.op)) {
      errors.push(`unknown_operator:${String(obj.op)}`);
      continue;
    }
    const value = Number(obj.value);
    if (!Number.isFinite(value)) {
      errors.push(`invalid_condition_value:${obj.field}`);
      continue;
    }
    out.push({ field: obj.field, op: obj.op, value: Math.trunc(value) });
  }
  return out;
}

export function validateAutomation(input: AutomationInput): AutomationValidation {
  const errors: string[] = [];

  const name = String(input.name ?? "").trim();
  if (!name) errors.push("name_required");
  else if (name.length > MAX_AUTOMATION_NAME) errors.push("name_too_long");

  const triggerKind = input.triggerKind;
  if (!isCoworkerTriggerKind(triggerKind)) errors.push("invalid_trigger");

  let eventKind: AutomationEventKind | null = null;
  let scheduleHour: number | null = null;
  let scheduleWeekday: number | null = null;

  if (triggerKind === "event") {
    const raw = input.eventKind;
    if (!isCoworkerEventKind(raw) || !(AUTOMATION_EVENT_KINDS as readonly string[]).includes(raw)) {
      errors.push("invalid_event_kind");
    } else {
      eventKind = raw as AutomationEventKind;
    }
  } else if (triggerKind === "schedule") {
    const hour = Number(input.scheduleHour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.push("invalid_schedule_hour");
    else scheduleHour = hour;
    if (input.scheduleWeekday !== undefined && input.scheduleWeekday !== null) {
      const wd = Number(input.scheduleWeekday);
      if (!Number.isInteger(wd) || wd < 0 || wd > 6) errors.push("invalid_schedule_weekday");
      else scheduleWeekday = wd;
    }
  }

  const locationId =
    typeof input.locationId === "string" && input.locationId.trim() ? input.locationId.trim() : null;

  // The project this automation serves, if any. Shape-validated here (a string
  // id or nothing); that the id names a real project of THIS business is
  // checked against the DB in the service layer, where the tenant scope lives.
  const projectId =
    typeof input.projectId === "string" && input.projectId.trim() ? input.projectId.trim() : null;

  // Conditions
  const conditionsRaw = (input.conditions ?? {}) as Record<string, unknown>;
  const all = normalizeConditionList(conditionsRaw.all, errors, "all");
  const any = normalizeConditionList(conditionsRaw.any, errors, "any");
  if (all.length + any.length > MAX_AUTOMATION_CONDITIONS) errors.push("too_many_conditions");
  const conditions: AutomationConditionDoc = {};
  if (all.length > 0) conditions.all = all;
  if (any.length > 0) conditions.any = any;

  // Action
  const actionType = input.actionType;
  const selectableActions = new Set<string>(selectableAutomationActions());
  if (!isKnownAction(actionType) || !selectableActions.has(actionType)) {
    errors.push(`unknown_action:${String(actionType)}`);
  }
  const actionPayload =
    input.actionPayload && typeof input.actionPayload === "object" && !Array.isArray(input.actionPayload)
      ? (input.actionPayload as Record<string, unknown>)
      : {};

  const approvalMode: AutomationApprovalMode = input.approvalMode === "auto" ? "auto" : "ask";
  const enabled = input.enabled === undefined ? true : input.enabled === true;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      locationId,
      projectId,
      triggerKind: triggerKind as AutomationTriggerKind,
      eventKind,
      scheduleHour,
      scheduleWeekday,
      conditions,
      actionType: actionType as ActionType,
      actionPayload,
      approvalMode,
      enabled,
    },
  };
}

const AUTOMATION_ERROR_MESSAGES: Record<string, string> = {
  name_required: "نام اتوماسیون را وارد کنید.",
  name_too_long: "نام اتوماسیون بیش از حد بلند است.",
  invalid_trigger: "نوع رویداد شروع معتبر نیست.",
  invalid_event_kind: "رویداد کاری انتخاب‌شده معتبر نیست.",
  invalid_schedule_hour: "ساعت زمان‌بندی معتبر نیست.",
  invalid_schedule_weekday: "روز هفتهٔ زمان‌بندی معتبر نیست.",
  too_many_conditions: "تعداد شرط‌ها بیش از حد مجاز است.",
  conditions_all_invalid: "ساختار شرط‌ها معتبر نیست.",
  conditions_any_invalid: "ساختار شرط‌ها معتبر نیست.",
  name_taken: "اتوماسیونی با این نام از قبل وجود دارد.",
  not_found: "اتوماسیون پیدا نشد.",
  project_not_found: "پروژهٔ انتخاب‌شده پیدا نشد.",
  owner_required: "فقط مالک می‌تواند اجرای خودکار را فعال کند.",
};

export function automationErrorMessage(code: string): string {
  if (code.startsWith("unknown_field:")) return "فیلد شرط انتخاب‌شده معتبر نیست.";
  if (code.startsWith("unknown_operator:")) return "عملگر شرط انتخاب‌شده معتبر نیست.";
  if (code.startsWith("invalid_condition_value:")) return "مقدار شرط معتبر نیست.";
  if (code.startsWith("unknown_action:")) return "نوع عملیات انتخاب‌شده معتبر نیست.";
  return AUTOMATION_ERROR_MESSAGES[code] ?? "درخواست نامعتبر است.";
}
