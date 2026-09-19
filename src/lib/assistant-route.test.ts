import { describe, expect, it } from "vitest";
import { isAssistantSurface } from "./assistant-route";

describe("isAssistantSurface", () => {
  it("treats the chat root as an assistant (full-height, pinned composer) surface", () => {
    expect(isAssistantSurface("/ai", false)).toBe(true);
    expect(isAssistantSurface("/ai", true)).toBe(true);
  });

  it("treats the workspace chat home /dashboard as one only when the workspace shell is on", () => {
    expect(isAssistantSurface("/dashboard", true)).toBe(true);
    expect(isAssistantSurface("/dashboard", false)).toBe(false);
  });

  it("does NOT treat the AI Workspace management sections as chat surfaces", () => {
    // These are ordinary scrolling pages with the normal chrome, not the
    // pinned-composer chat — the Phase I regression this guards.
    for (const path of ["/ai/agents", "/ai/coworkers", "/ai/automations", "/ai/activity", "/ai/usage", "/ai/coworkers/x"]) {
      expect(isAssistantSurface(path, false)).toBe(false);
      expect(isAssistantSurface(path, true)).toBe(false);
    }
  });

  it("is false for unrelated pages", () => {
    expect(isAssistantSurface("/media", true)).toBe(false);
    expect(isAssistantSurface("/projects", true)).toBe(false);
  });
});
