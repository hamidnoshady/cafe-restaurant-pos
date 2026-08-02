import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_KIND,
  AI_AGENT_DEFINITIONS,
  AI_AGENT_KEYS,
  aiAgentsTodayTasks,
  aiAgentStatus,
  defaultAiAgentSettings,
  digestSectionInclusion,
  hasAnyDigestContent,
  isAiAgentKey,
} from "./ai-agents";

describe("AI agent definitions", () => {
  it("has one definition per agent key, in a stable order", () => {
    expect(AI_AGENT_DEFINITIONS.map((d) => d.key)).toEqual(AI_AGENT_KEYS);
  });

  it("defaults every agent to disabled, mirroring the old opt-in switch", () => {
    const settings = defaultAiAgentSettings();
    for (const key of AI_AGENT_KEYS) {
      expect(settings[key]).toEqual({ enabled: false, scheduleHour: 8 });
    }
  });

  it("recognizes only the four documented agent keys", () => {
    expect(isAiAgentKey("financial_report_builder")).toBe(true);
    expect(isAiAgentKey("sales_analyzer")).toBe(true);
    expect(isAiAgentKey("not_a_real_agent")).toBe(false);
    expect(isAiAgentKey(42)).toBe(false);
  });
});

describe("aiAgentStatus", () => {
  const agent = { enabled: true, scheduleHour: 8 };

  it("is inactive when the master switch is off, even if the agent itself is enabled", () => {
    expect(aiAgentStatus({ masterEnabled: false, agent, currentHour: 12 })).toBe("inactive");
  });

  it("is inactive when the agent itself is off", () => {
    expect(aiAgentStatus({ masterEnabled: true, agent: { enabled: false, scheduleHour: 8 }, currentHour: 12 })).toBe(
      "inactive",
    );
  });

  it("is scheduled before its hour, active from its hour onward", () => {
    expect(aiAgentStatus({ masterEnabled: true, agent, currentHour: 7 })).toBe("scheduled");
    expect(aiAgentStatus({ masterEnabled: true, agent, currentHour: 8 })).toBe("active");
    expect(aiAgentStatus({ masterEnabled: true, agent, currentHour: 23 })).toBe("active");
  });
});

describe("digest section inclusion", () => {
  it("maps each digest-contributing agent to its own section flag", () => {
    const settings = defaultAiAgentSettings();
    settings.sales_analyzer.enabled = true;
    expect(digestSectionInclusion(settings)).toEqual({ financial: false, sales: true, reconciliation: false });
  });

  it("has content once any of the three digest agents is on", () => {
    expect(hasAnyDigestContent({ financial: false, sales: false, reconciliation: false })).toBe(false);
    expect(hasAnyDigestContent({ financial: false, sales: false, reconciliation: true })).toBe(true);
  });
});

describe("aiAgentsTodayTasks", () => {
  const SATURDAY = 6;
  const SUNDAY = 0;

  function settingsWith(overrides: Partial<Record<(typeof AI_AGENT_KEYS)[number], { enabled: boolean; scheduleHour: number }>>) {
    const settings = defaultAiAgentSettings();
    for (const [key, value] of Object.entries(overrides)) {
      settings[key as (typeof AI_AGENT_KEYS)[number]] = value!;
    }
    return settings;
  }

  it("is empty when the master switch is off, regardless of per-agent settings", () => {
    const agentSettings = settingsWith({ financial_report_builder: { enabled: true, scheduleHour: 9 } });
    const tasks = aiAgentsTodayTasks({
      masterEnabled: false,
      agentSettings,
      weeklyDigestWeekday: SATURDAY,
      currentWeekday: SATURDAY,
      hasRunForKind: () => false,
    });
    expect(tasks).toEqual([]);
  });

  it("omits disabled agents", () => {
    const agentSettings = settingsWith({ financial_report_builder: { enabled: false, scheduleHour: 9 } });
    const tasks = aiAgentsTodayTasks({
      masterEnabled: true,
      agentSettings,
      weeklyDigestWeekday: SATURDAY,
      currentWeekday: SUNDAY,
      hasRunForKind: () => false,
    });
    expect(tasks.find((t) => t.agentKey === "financial_report_builder")).toBeUndefined();
  });

  it("marks an agent pending when no matching run exists yet, done once one does", () => {
    const agentSettings = settingsWith({ financial_report_builder: { enabled: true, scheduleHour: 9 } });
    const pending = aiAgentsTodayTasks({
      masterEnabled: true,
      agentSettings,
      weeklyDigestWeekday: SATURDAY,
      currentWeekday: SUNDAY,
      hasRunForKind: () => false,
    });
    expect(pending).toEqual([{ agentKey: "financial_report_builder", label: "گزارش‌ساز مالی", scheduledHour: 9, status: "pending" }]);

    const done = aiAgentsTodayTasks({
      masterEnabled: true,
      agentSettings,
      weeklyDigestWeekday: SATURDAY,
      currentWeekday: SUNDAY,
      hasRunForKind: (kind) => kind === AGENT_RUN_KIND.financial_report_builder,
    });
    expect(done[0]?.status).toBe("done");
  });

  it("only lists the weekly-digest agent on the configured weekly weekday", () => {
    const agentSettings = settingsWith({ sales_analyzer: { enabled: true, scheduleHour: 10 } });
    const onWeekday = aiAgentsTodayTasks({
      masterEnabled: true,
      agentSettings,
      weeklyDigestWeekday: SATURDAY,
      currentWeekday: SATURDAY,
      hasRunForKind: () => false,
    });
    expect(onWeekday.map((t) => t.agentKey)).toEqual(["sales_analyzer"]);

    const offWeekday = aiAgentsTodayTasks({
      masterEnabled: true,
      agentSettings,
      weeklyDigestWeekday: SATURDAY,
      currentWeekday: SUNDAY,
      hasRunForKind: () => false,
    });
    expect(offWeekday).toEqual([]);
  });

  it("sorts the list by scheduled hour", () => {
    const agentSettings = settingsWith({
      financial_report_builder: { enabled: true, scheduleHour: 14 },
      reconciliation_assistant: { enabled: true, scheduleHour: 9 },
      receivables_follow_up: { enabled: true, scheduleHour: 12 },
    });
    const tasks = aiAgentsTodayTasks({
      masterEnabled: true,
      agentSettings,
      weeklyDigestWeekday: SATURDAY,
      currentWeekday: SUNDAY,
      hasRunForKind: () => false,
    });
    expect(tasks.map((t) => t.agentKey)).toEqual([
      "reconciliation_assistant",
      "receivables_follow_up",
      "financial_report_builder",
    ]);
  });
});
