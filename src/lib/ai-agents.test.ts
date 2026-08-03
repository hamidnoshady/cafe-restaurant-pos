import { describe, expect, it } from "vitest";
import {
  AI_AGENT_DEFINITIONS,
  AI_AGENT_KEYS,
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
