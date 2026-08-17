/**
 * AI Hub Wave 3 (Issue #143) — pure definitions and scheduling logic for the
 * four independent background agents that replace the single
 * `ai_proactive_settings.enabled` switch. Database access and the digest
 * pipeline itself stay in ai-proactive-service.ts, the same split as
 * ai-proactive.ts/ai-proactive-service.ts.
 */
import { DEFAULT_PROACTIVE_HOUR, type AiProactiveRunKind } from "./ai-proactive";

export const AI_AGENT_KEYS = [
  "financial_report_builder",
  "sales_analyzer",
  "receivables_follow_up",
  "reconciliation_assistant",
  "service_reminders",
] as const;

export type AiAgentKey = (typeof AI_AGENT_KEYS)[number];

export interface AiAgentDefinition {
  key: AiAgentKey;
  title: string;
  description: string;
}

/** Order here is the display order for the hub's "ایجنت‌های فعال" column. */
export const AI_AGENT_DEFINITIONS: AiAgentDefinition[] = [
  {
    key: "financial_report_builder",
    title: "گزارش‌ساز مالی",
    description: "خلاصهٔ روزانهٔ فروش، مالیات، حقوق و ارزش موجودی را آماده می‌کند.",
  },
  {
    key: "sales_analyzer",
    title: "تحلیلگر فروش",
    description: "روند فروش، الگوی ابطال/تخفیف و عملکرد آیتم‌های منو را هفتگی بررسی می‌کند.",
  },
  {
    key: "receivables_follow_up",
    title: "پیگیری مطالبات",
    description: "برای مشتریان بدهکار پیش‌نویس پیام یادآوری آماده می‌کند؛ هیچ پیامی خودکار ارسال نمی‌شود.",
  },
  {
    key: "reconciliation_assistant",
    title: "دستیار مغایرت‌گیری",
    description: "مغایرت صندوق پایان شیفت و ردیف‌های بانکی تطبیق‌نشده را هشدار می‌دهد.",
  },
  {
    key: "service_reminders",
    title: "یادآور سرویس ساعت",
    description: "برای ساعت‌های فروخته‌شده‌ای که موعد سرویس‌شان رسیده پیش‌نویس یادآوری آماده می‌کند؛ هیچ پیامی خودکار ارسال نمی‌شود.",
  },
];

export interface AiAgentSetting {
  enabled: boolean;
  scheduleHour: number;
}

export type AiAgentSettingsMap = Record<AiAgentKey, AiAgentSetting>;

export const DEFAULT_AI_AGENT_SETTING: AiAgentSetting = {
  enabled: false,
  scheduleHour: DEFAULT_PROACTIVE_HOUR,
};

export function defaultAiAgentSettings(): AiAgentSettingsMap {
  return Object.fromEntries(AI_AGENT_KEYS.map((key) => [key, { ...DEFAULT_AI_AGENT_SETTING }])) as AiAgentSettingsMap;
}

export function isAiAgentKey(value: unknown): value is AiAgentKey {
  return typeof value === "string" && (AI_AGENT_KEYS as readonly string[]).includes(value);
}

export type AiAgentStatus = "active" | "scheduled" | "inactive";

/**
 * The status pill shown on each agent card. `masterEnabled` is the overall
 * `ai_proactive_settings.enabled` opt-in switch — when it's off nothing runs
 * regardless of a single agent's own toggle, so every card reads inactive.
 */
export function aiAgentStatus(input: {
  masterEnabled: boolean;
  agent: AiAgentSetting;
  currentHour: number;
}): AiAgentStatus {
  if (!input.masterEnabled || !input.agent.enabled) return "inactive";
  return input.currentHour < input.agent.scheduleHour ? "scheduled" : "active";
}

/** The three digest-contributing agents; receivables_follow_up owns its own run kind instead. */
export type DigestAgentKey = "financial_report_builder" | "sales_analyzer" | "reconciliation_assistant";

export interface DigestSectionInclusion {
  financial: boolean;
  sales: boolean;
  reconciliation: boolean;
}

/** True once at least one agent would contribute a section to the digest — the run is worth claiming/paying for. */
export function hasAnyDigestContent(inclusion: DigestSectionInclusion): boolean {
  return inclusion.financial || inclusion.sales || inclusion.reconciliation;
}

export function digestSectionInclusion(settings: AiAgentSettingsMap): DigestSectionInclusion {
  return {
    financial: settings.financial_report_builder.enabled,
    sales: settings.sales_analyzer.enabled,
    reconciliation: settings.reconciliation_assistant.enabled,
  };
}

/** The `ai_proactive_runs.kind` each agent's work is recorded under — also used for the hub's last-run stats. */
export const AGENT_RUN_KIND: Record<AiAgentKey, AiProactiveRunKind> = {
  financial_report_builder: "daily_digest",
  reconciliation_assistant: "daily_digest",
  sales_analyzer: "weekly_digest",
  receivables_follow_up: "customer_debt_drafts",
  service_reminders: "service_reminder_drafts",
};

export type AiAgentTaskStatus = "done" | "pending";

export interface AiAgentTodayTask {
  agentKey: AiAgentKey;
  label: string;
  scheduledHour: number;
  status: AiAgentTaskStatus;
}

/**
 * Wave 4 (issue #144) hub sidebar: "today's automated tasks" list. Purely
 * derived from settings + whether a matching `ai_proactive_runs` row already
 * exists for today — no new schema, no provider call. A weekly-digest agent
 * (sales_analyzer) only appears on the configured weekly weekday, since it
 * has no run due on any other day.
 */
export function aiAgentsTodayTasks(input: {
  masterEnabled: boolean;
  agentSettings: AiAgentSettingsMap;
  weeklyDigestWeekday: number;
  currentWeekday: number;
  hasRunForKind: (runKind: AiProactiveRunKind) => boolean;
}): AiAgentTodayTask[] {
  if (!input.masterEnabled) return [];
  const tasks: AiAgentTodayTask[] = [];
  for (const definition of AI_AGENT_DEFINITIONS) {
    const agent = input.agentSettings[definition.key];
    if (!agent.enabled) continue;
    const runKind = AGENT_RUN_KIND[definition.key];
    if (runKind === "weekly_digest" && input.currentWeekday !== input.weeklyDigestWeekday) continue;
    tasks.push({
      agentKey: definition.key,
      label: definition.title,
      scheduledHour: agent.scheduleHour,
      status: input.hasRunForKind(runKind) ? "done" : "pending",
    });
  }
  return tasks.sort((a, b) => a.scheduledHour - b.scheduledHour);
}
