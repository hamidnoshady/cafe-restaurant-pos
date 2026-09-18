import { describe, expect, it } from "vitest";
import {
  PROMPT_FRAGMENTS,
  RULE_KEYS,
  RULE_BEARING_SURFACES,
  fragmentsForTurn,
  assembleFromFragments,
  type FragmentKey,
} from "./ai-prompts";

describe("PROMPT_FRAGMENTS", () => {
  it("has a default for every declared key", () => {
    // Every FragmentKey must have a code default — a DB override is optional,
    // but silence is not. This is the "a bad edit or unmigrated deploy must
    // not silence the assistant" guarantee.
    const allKeys: FragmentKey[] = [
      "base",
      "context",
      "surface:wizard",
      "surface:dashboard",
      "surface:floor",
      "surface:autopilot",
      "surface:proactive",
      "surface:platform",
      "rule:no_ids",
      "rule:no_raw_db",
      "rule:disabled_is_valid",
      "rule:toman",
      "rule:mobile",
      "rule:describe_app",
      // No `app:connections`: the «اتصال‌های فنی» hub is shell
      // infrastructure, not an app, so it contributes no prompt fragment.
      "app:growth",
      "app:accounting",
      "project",
    ];
    for (const key of allKeys) {
      expect(PROMPT_FRAGMENTS[key], `fragment ${key}`).toBeDefined();
    }
  });

  it("has non-empty text for base and all rule keys", () => {
    expect(PROMPT_FRAGMENTS.base.trim()).toBeTruthy();
    for (const rule of RULE_KEYS) {
      expect(PROMPT_FRAGMENTS[rule].trim(), rule).toBeTruthy();
    }
  });

  it("has non-empty text for all surface keys", () => {
    const surfaces = [
      "surface:wizard",
      "surface:dashboard",
      "surface:floor",
      "surface:autopilot",
      "surface:proactive",
      "surface:platform",
    ];
    for (const key of surfaces) {
      expect(PROMPT_FRAGMENTS[key as FragmentKey].trim(), key).toBeTruthy();
    }
  });
});

describe("fragmentsForTurn", () => {
  it("always includes base", () => {
    const keys = fragmentsForTurn({ mode: "dashboard" });
    expect(keys).toContain("base");
  });

  it("includes the surface fragment for the mode", () => {
    expect(fragmentsForTurn({ mode: "dashboard" })).toContain("surface:dashboard");
    expect(fragmentsForTurn({ mode: "floor" })).toContain("surface:floor");
    expect(fragmentsForTurn({ mode: "wizard" })).toContain("surface:wizard");
  });

  it("includes all Phase 33 rules for dashboard, wizard, and floor", () => {
    for (const mode of RULE_BEARING_SURFACES) {
      const keys = fragmentsForTurn({ mode });
      for (const rule of RULE_KEYS) {
        expect(keys, `${mode} should include ${rule}`).toContain(rule);
      }
    }
  });

  it("does not include rules for autopilot, proactive, or support", () => {
    for (const mode of ["autopilot", "proactive", "platform"] as const) {
      const keys = fragmentsForTurn({ mode });
      for (const rule of RULE_KEYS) {
        expect(keys, `${mode} should not include ${rule}`).not.toContain(rule);
      }
    }
  });

  it("includes app fragments only for dashboard mode with apps specified", () => {
    const withApps = fragmentsForTurn({ mode: "dashboard", apps: ["accounting"] });
    expect(withApps).toContain("app:accounting");
    expect(withApps).toContain("app:accounting");
    expect(withApps).not.toContain("app:growth");

    // Without apps specified, no app fragments
    const noApps = fragmentsForTurn({ mode: "dashboard" });
    expect(noApps).not.toContain("app:accounting");
  });

  it("does not include app fragments for non-dashboard modes", () => {
    const keys = fragmentsForTurn({ mode: "floor", apps: ["accounting"] });
    expect(keys).not.toContain("app:accounting");
  });

  it("includes project fragment when hasProject is true", () => {
    expect(fragmentsForTurn({ mode: "dashboard", hasProject: true })).toContain("project");
    expect(fragmentsForTurn({ mode: "dashboard", hasProject: false })).not.toContain("project");
  });
});

describe("assembleFromFragments", () => {
  it("includes business name and user when provided", () => {
    const result = assembleFromFragments(
      ["base", "context"],
      { businessName: "کافه ریحان", userName: "علی", role: "owner" },
    );
    expect(result).toContain("کافه ریحان");
    expect(result).toContain("علی");
    expect(result).toContain("owner");
  });

  it("uses DB overrides when provided", () => {
    const overrides = new Map<FragmentKey, string>();
    overrides.set("base", "Custom base prompt");
    const result = assembleFromFragments(["base"], {}, overrides);
    expect(result).toBe("Custom base prompt");
  });

  it("falls back to code default when no override exists", () => {
    const result = assembleFromFragments(["base"], {});
    expect(result).toContain("دستیار هوشمند");
  });

  it("includes project instructions when provided", () => {
    const result = assembleFromFragments(
      ["base", "project"],
      {},
      undefined,
      "دستور پروژه: روی فروش تمرکز کن",
    );
    expect(result).toContain("دستور پروژه");
    expect(result).toContain("روی فروش تمرکز کن");
  });

  it("produces shorter output for a single-app turn than a full turn", () => {
    const fullKeys = fragmentsForTurn({ mode: "dashboard", apps: ["accounting", "growth", "crm", "website"] });
    const singleKeys = fragmentsForTurn({ mode: "dashboard", apps: ["accounting"] });

    const fullPrompt = assembleFromFragments(fullKeys, { businessName: "Test" });
    const singlePrompt = assembleFromFragments(singleKeys, { businessName: "Test" });

    expect(singlePrompt.length).toBeLessThan(fullPrompt.length);
  });

  it("dashboard prompt includes all 6 Phase 33 rules", () => {
    const keys = fragmentsForTurn({ mode: "dashboard" });
    const result = assembleFromFragments(keys, {});
    // Check for distinctive phrases from each rule
    expect(result).toContain("شناسه (id/UUID)"); // no_ids
    expect(result).toContain("spoilage"); // no_raw_db
    expect(result).toContain("غیرفعال است"); // disabled_is_valid
    expect(result).toContain("تومان"); // toman
    expect(result).toContain("موبایل"); // mobile
    expect(result).toContain("describe_app"); // describe_app
  });
});
