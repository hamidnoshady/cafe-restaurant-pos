/**
 * Phase 32 — the pure core of the AI coworker.
 *
 * A *job* is the noun this phase adds: a piece of accounting work the owner
 * describes once ("every night when the shift closes, write off the bread that
 * is left"), which then fires on a trigger without anybody typing it again.
 *
 * Everything here is deterministic and framework-free — no DB, no provider, no
 * `next/*` — because that is the whole point of the design: a job that runs
 * every night must produce the *same* actions from the same facts. The model
 * helps an owner author a job and talk about its results; it is not in the
 * loop when one fires. Database access lives in ai-coworker-service.ts and the
 * template builders in ai-coworker-templates.ts.
 *
 * The approval gate deliberately reuses Phase 31's `evaluateAutopilotProposal`
 * rather than inventing a second ceiling: an owner who set "money: at most
 * 5,000,000 ﷼ unattended" said that about their business, not about one
 * feature, so a coworker job cannot be a way around it.
 */

import { ACTION_CATALOG, type ActionType, type ProposedAction } from "./ai";
import {
  evaluateUnattendedAction,
  type AutopilotAmountContext,
  type AutopilotCategorySetting,
  type AutopilotDecision,
} from "./ai-autopilot";
import type { LocalBusinessClock } from "./ai-proactive";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Business events, not clock times. "After the shift closes" is a fact
 * `employee_shifts` already knows; a cron expression can only guess at it, and
 * guesses wrong exactly on the nights that ran long.
 */
export const COWORKER_EVENT_KINDS = [
  "shift_open", "shift_close", "day_close",
  // Phase 37b Wave 5: customer events originate in foreground/scheduled
  // producers, then follow this exact durable coworker queue.
  "customer_birthday", "customer_inactive_3_months", "order_ready",
] as const;
export type CoworkerEventKind = (typeof COWORKER_EVENT_KINDS)[number];

export const COWORKER_EVENT_LABELS: Record<CoworkerEventKind, string> = {
  shift_open: "با شروع هر شیفت",
  shift_close: "با پایان هر شیفت",
  day_close: "با بستن روز کاری",
  customer_birthday: "در روز تولد مشتری",
  customer_inactive_3_months: "سه ماه پس از آخرین خرید مشتری",
  order_ready: "با آماده‌شدن سفارش مشتری",
};

export const COWORKER_TRIGGER_KINDS = ["manual", "schedule", "event"] as const;
export type CoworkerTriggerKind = (typeof COWORKER_TRIGGER_KINDS)[number];

export const COWORKER_TRIGGER_LABELS: Record<CoworkerTriggerKind, string> = {
  manual: "فقط با درخواست من",
  schedule: "در ساعت مشخصی از روز",
  event: "با یک رویداد کاری",
};

export type CoworkerApprovalMode = "ask" | "auto";

export const COWORKER_APPROVAL_LABELS: Record<CoworkerApprovalMode, string> = {
  ask: "قبل از ثبت از من بپرس",
  auto: "خودت ثبت کن (در سقف‌های تعیین‌شده)",
};

export type CoworkerRunStatus =
  | "pending_approval"
  | "applied"
  | "partially_applied"
  | "rejected"
  | "failed"
  | "skipped"
  // A run that produced a report rather than a change — the accounting review.
  // Distinct from `skipped`, which means "nothing to do": a review that found
  // eleven problems did plenty, it just did not write anything.
  | "reported";

export const COWORKER_RUN_STATUS_LABELS: Record<CoworkerRunStatus, string> = {
  pending_approval: "در انتظار تأیید شما",
  applied: "ثبت شد",
  partially_applied: "بخشی ثبت شد",
  rejected: "رد شد",
  failed: "ناموفق",
  skipped: "کاری برای انجام نبود",
  reported: "گزارش آماده است",
};

export type CoworkerActionStatus = "pending" | "applied" | "failed" | "rejected" | "skipped";

export function isCoworkerEventKind(value: unknown): value is CoworkerEventKind {
  return typeof value === "string" && (COWORKER_EVENT_KINDS as readonly string[]).includes(value);
}

export function isCoworkerTriggerKind(value: unknown): value is CoworkerTriggerKind {
  return typeof value === "string" && (COWORKER_TRIGGER_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Job definition + validation
// ---------------------------------------------------------------------------

export interface CoworkerJobInput {
  templateKey: string;
  title: string;
  locationId: string | null;
  triggerKind: CoworkerTriggerKind;
  eventKind: CoworkerEventKind | null;
  scheduleHour: number | null;
  /** null = every day; 0..6 (Sunday..Saturday, the JS convention) pins a weekday. */
  scheduleWeekday: number | null;
  params: Record<string, unknown>;
  approvalMode: CoworkerApprovalMode;
  enabled: boolean;
}

/**
 * Validates the *shape* of a job. The template's own parameter validation is a
 * separate step (`validateTemplateParams`), so an unknown template key and a
 * malformed schedule are two distinguishable errors rather than one vague one.
 */
export function validateJobInput(input: Partial<CoworkerJobInput>): string[] {
  const errors: string[] = [];

  if (typeof input.templateKey !== "string" || input.templateKey.trim().length === 0) {
    errors.push("coworker_template_required");
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0 || input.title.length > 120) {
    errors.push("coworker_title_invalid");
  }
  if (!isCoworkerTriggerKind(input.triggerKind)) {
    errors.push("coworker_trigger_invalid");
    return errors;
  }

  if (input.triggerKind === "event") {
    if (!isCoworkerEventKind(input.eventKind)) errors.push("coworker_event_required");
    if (input.scheduleHour !== null && input.scheduleHour !== undefined) errors.push("coworker_trigger_mixed");
  } else if (input.triggerKind === "schedule") {
    const hour = input.scheduleHour;
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      errors.push("coworker_hour_invalid");
    }
    if (input.eventKind) errors.push("coworker_trigger_mixed");
    const weekday = input.scheduleWeekday;
    if (weekday !== null && weekday !== undefined) {
      if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) errors.push("coworker_weekday_invalid");
    }
  } else {
    if (input.eventKind) errors.push("coworker_trigger_mixed");
    if (input.scheduleHour !== null && input.scheduleHour !== undefined) errors.push("coworker_trigger_mixed");
  }

  if (input.approvalMode !== "ask" && input.approvalMode !== "auto") {
    errors.push("coworker_approval_invalid");
  }
  if (input.params !== undefined && (typeof input.params !== "object" || input.params === null || Array.isArray(input.params))) {
    errors.push("coworker_params_invalid");
  }

  return errors;
}

export const COWORKER_ERROR_MESSAGES: Record<string, string> = {
  coworker_template_required: "قالب کار مشخص نشده است.",
  coworker_template_unknown: "این قالب کار وجود ندارد.",
  coworker_title_invalid: "عنوان کار را وارد کنید (حداکثر ۱۲۰ نویسه).",
  coworker_trigger_invalid: "نوع زمان‌بندی معتبر نیست.",
  coworker_trigger_mixed: "برای هر کار فقط یک نوع زمان‌بندی می‌توان تعیین کرد.",
  coworker_event_required: "رویداد شروع‌کنندهٔ کار را انتخاب کنید.",
  coworker_hour_invalid: "ساعت اجرا باید عددی بین ۰ تا ۲۳ باشد.",
  coworker_weekday_invalid: "روز هفته معتبر نیست.",
  coworker_approval_invalid: "حالت تأیید معتبر نیست.",
  coworker_params_invalid: "تنظیمات این کار معتبر نیست.",
  coworker_trigger_unsupported: "این قالب با این نوع زمان‌بندی کار نمی‌کند.",
  coworker_auto_needs_authorizer: "برای «خودت ثبت کن» باید کاربر تأییدکننده مشخص باشد.",
  coworker_job_not_found: "این کار پیدا نشد.",
  coworker_run_not_found: "این اجرا پیدا نشد.",
  coworker_run_already_decided: "برای این اجرا قبلاً تصمیم گرفته شده است.",
  coworker_module_unavailable: "این قالب برای صنف شما در دسترس نیست.",
};

export function coworkerErrorMessage(code: string): string {
  return COWORKER_ERROR_MESSAGES[code] ?? "درخواست معتبر نیست.";
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * `ai_coworker_runs` has UNIQUE (job_id, dedupe_key), so these keys are the
 * whole defence against a tick that runs twice — or two app instances ticking
 * at once — writing the same night off twice.
 */
export function dedupeKeyForEvent(eventId: string): string {
  return `event:${eventId}`;
}

export function dedupeKeyForSchedule(clock: LocalBusinessClock, hour: number): string {
  return `schedule:${clock.dateKey}:${String(hour).padStart(2, "0")}`;
}

export function dedupeKeyForManual(now: Date): string {
  return `manual:${now.toISOString()}`;
}

/**
 * A scheduled job is due once per local business day, from its hour onwards —
 * the same "catch up rather than miss" rule `dueProactiveRuns` uses, so a box
 * that was asleep at 23:00 still runs the job when it wakes at 23:40 instead
 * of silently skipping the night.
 *
 * Returns the dedupe key to claim, or null when the job is not due; the
 * UNIQUE constraint (not this function) is what makes the claim atomic.
 */
export function scheduleDedupeKeyIfDue(
  job: Pick<CoworkerJobInput, "triggerKind" | "scheduleHour" | "scheduleWeekday" | "enabled">,
  clock: LocalBusinessClock,
): string | null {
  if (!job.enabled || job.triggerKind !== "schedule") return null;
  if (job.scheduleHour === null || clock.hour < job.scheduleHour) return null;
  if (job.scheduleWeekday !== null && clock.weekday !== job.scheduleWeekday) return null;
  return dedupeKeyForSchedule(clock, job.scheduleHour);
}

/** True when an event should start this job: same kind, and same branch (or all-branch). */
export function eventMatchesJob(
  job: Pick<CoworkerJobInput, "triggerKind" | "eventKind" | "locationId" | "enabled">,
  event: { kind: CoworkerEventKind; locationId: string | null },
): boolean {
  if (!job.enabled || job.triggerKind !== "event") return false;
  if (job.eventKind !== event.kind) return false;
  // A job scoped to a branch ignores every other branch's events. A job with
  // no branch follows whichever branch raised the event.
  return job.locationId === null || job.locationId === event.locationId;
}

// ---------------------------------------------------------------------------
// The approval gate
// ---------------------------------------------------------------------------

export interface CoworkerActionPlan {
  action: ProposedAction;
  decision: AutopilotDecision;
}

export interface CoworkerApprovalInput {
  approvalMode: CoworkerApprovalMode;
  /** Whether a real user's authority backs an unattended write (jobs.authorized_by). */
  hasAuthorizer: boolean;
  actions: ProposedAction[];
  /** Phase 31's per-category settings, read from the database, keyed by category. */
  settingFor: (type: ActionType) => AutopilotCategorySetting | null;
  appliedTodayInCategory: (type: ActionType) => number;
  contextFor: (action: ProposedAction) => AutopilotAmountContext;
}

/**
 * Decides, per action, whether this run may write without waiting for a human.
 *
 * Three gates, all of which must pass, and none of which the job's own
 * `approvalMode` can override:
 *   1. the owner set this job to 'auto' at all;
 *   2. a real user's authority backs it (jobs.authorized_by);
 *   3. Phase 31's category caps admit this specific payload.
 *
 * A "no" on any of them is never a drop: the action is still written to the
 * run, still shown, and still applies on the identical manual path when the
 * owner taps approve — exactly the Phase 31 rule that over-cap means *held*,
 * not *dropped* and not *forced*.
 */
export function planCoworkerActions(input: CoworkerApprovalInput): CoworkerActionPlan[] {
  // The whole gate is `evaluateUnattendedAction` — the ONE named ceiling that
  // autopilot and automations funnel through too, so a coworker job cannot be
  // a way around the caps an owner set for their business. This function only
  // adapts the per-action inputs to it.
  return input.actions.map((action) => ({
    action,
    decision: evaluateUnattendedAction({
      meta: ACTION_CATALOG[action.type],
      payload: action.payload,
      approvalMode: input.approvalMode,
      hasAuthorizer: input.hasAuthorizer,
      setting: input.settingFor(action.type),
      appliedTodayInCategory: input.appliedTodayInCategory(action.type),
      context: input.contextFor(action),
    }),
  }));
}

/**
 * The run's status once every action has an outcome. `partially_applied`
 * exists because a night's write-off is five items: "failed" would be a lie
 * about the four that went through.
 */
export function runStatusFromActions(statuses: readonly CoworkerActionStatus[]): CoworkerRunStatus {
  if (statuses.length === 0) return "skipped";
  if (statuses.some((s) => s === "pending")) return "pending_approval";

  const applied = statuses.filter((s) => s === "applied").length;
  const failed = statuses.filter((s) => s === "failed").length;
  const rejected = statuses.filter((s) => s === "rejected").length;

  if (applied === 0 && failed === 0 && rejected === statuses.length) return "rejected";
  if (applied === 0 && failed > 0) return "failed";
  if (applied === 0) return "skipped";
  if (applied === statuses.length) return "applied";
  return "partially_applied";
}

/** Persian one-liner for the inbox card, built from what the run actually did. */
export function summarizeRun(input: {
  jobTitle: string;
  statuses: readonly CoworkerActionStatus[];
  skipReason?: string | null;
}): string {
  if (input.skipReason) return input.skipReason;
  const total = input.statuses.length;
  if (total === 0) return `${input.jobTitle}: موردی برای انجام پیدا نشد.`;
  const pending = input.statuses.filter((s) => s === "pending").length;
  if (pending === total) return `${input.jobTitle}: ${total} اقدام آمادهٔ تأیید شماست.`;
  const applied = input.statuses.filter((s) => s === "applied").length;
  const failed = input.statuses.filter((s) => s === "failed").length;
  const parts = [`${input.jobTitle}:`];
  if (applied > 0) parts.push(`${applied} اقدام ثبت شد`);
  if (pending > 0) parts.push(`${pending} اقدام در انتظار تأیید`);
  if (failed > 0) parts.push(`${failed} اقدام ناموفق`);
  return parts.join(" ");
}
