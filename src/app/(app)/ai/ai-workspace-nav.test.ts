import { describe, expect, it } from "vitest";
import {
  AI_WORKSPACE_SECTIONS,
  AI_WORKSPACE_SECTION_KEYS,
  activeAiWorkspaceSection,
  aiWorkspaceSection,
  canOpenAiWorkspace,
  canViewAiWorkspaceSection,
  isAiWorkspaceSectionPathname,
} from "./ai-workspace-nav";

describe("AI workspace section registry", () => {
  it("lists every declared section exactly once, in key order", () => {
    expect(AI_WORKSPACE_SECTIONS.map((s) => s.key)).toEqual([...AI_WORKSPACE_SECTION_KEYS]);
    const keys = new Set(AI_WORKSPACE_SECTIONS.map((s) => s.key));
    expect(keys.size).toBe(AI_WORKSPACE_SECTIONS.length);
  });

  it("gives every section a label, a description, an href and an icon", () => {
    for (const section of AI_WORKSPACE_SECTIONS) {
      expect(section.label.length).toBeGreaterThan(0);
      expect(section.description.length).toBeGreaterThan(0);
      expect(section.href.startsWith("/ai")).toBe(true);
      expect(section.icon.length).toBeGreaterThan(0);
    }
  });

  it("puts chat at the workspace root and nests the rest under it", () => {
    expect(aiWorkspaceSection("chat").href).toBe("/ai");
    for (const section of AI_WORKSPACE_SECTIONS) {
      if (section.key === "chat") continue;
      expect(section.href).toMatch(/^\/ai\/[a-z]+$/);
    }
  });

  it("throws on an unknown section key", () => {
    // @ts-expect-error — deliberately wrong key
    expect(() => aiWorkspaceSection("nope")).toThrow(/unknown/);
  });
});

describe("workspace section role gate", () => {
  it("admits owner and manager to every section", () => {
    for (const key of AI_WORKSPACE_SECTION_KEYS) {
      expect(canViewAiWorkspaceSection("owner", key)).toBe(true);
      expect(canViewAiWorkspaceSection("manager", key)).toBe(true);
    }
  });

  it("keeps cashier and accountant out of the whole workspace", () => {
    for (const key of AI_WORKSPACE_SECTION_KEYS) {
      expect(canViewAiWorkspaceSection("cashier", key)).toBe(false);
      expect(canViewAiWorkspaceSection("accountant", key)).toBe(false);
    }
    expect(canOpenAiWorkspace("cashier")).toBe(false);
    expect(canOpenAiWorkspace("accountant")).toBe(false);
    expect(canOpenAiWorkspace("owner")).toBe(true);
    expect(canOpenAiWorkspace("manager")).toBe(true);
  });
});

describe("active-section detection", () => {
  it("lights up chat only on the exact workspace root", () => {
    expect(isAiWorkspaceSectionPathname("/ai", "chat")).toBe(true);
    expect(isAiWorkspaceSectionPathname("/ai/coworkers", "chat")).toBe(false);
    expect(isAiWorkspaceSectionPathname("/ai/automations", "chat")).toBe(false);
  });

  it("lights up a management section on its page and nested paths", () => {
    expect(isAiWorkspaceSectionPathname("/ai/coworkers", "coworkers")).toBe(true);
    expect(isAiWorkspaceSectionPathname("/ai/coworkers/anything", "coworkers")).toBe(true);
    expect(isAiWorkspaceSectionPathname("/ai/automations", "coworkers")).toBe(false);
  });

  it("resolves the active section for a pathname, and null off the workspace", () => {
    expect(activeAiWorkspaceSection("/ai")).toBe("chat");
    expect(activeAiWorkspaceSection("/ai/agents")).toBe("agents");
    expect(activeAiWorkspaceSection("/ai/coworkers")).toBe("coworkers");
    expect(activeAiWorkspaceSection("/ai/automations")).toBe("automations");
    expect(activeAiWorkspaceSection("/ai/activity")).toBe("activity");
    expect(activeAiWorkspaceSection("/ai/usage")).toBe("usage");
    expect(activeAiWorkspaceSection("/media")).toBeNull();
    expect(activeAiWorkspaceSection("/dashboard")).toBeNull();
  });

  it("does not let the chat root prefix swallow a management path", () => {
    // The regression the longest-first order guards: `/ai/coworkers` must not
    // resolve to chat merely because it starts with `/ai`.
    expect(activeAiWorkspaceSection("/ai/coworkers")).not.toBe("chat");
  });
});
