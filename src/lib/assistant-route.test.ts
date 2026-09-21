import { describe, expect, it } from "vitest";
import { isAssistantSurface } from "./assistant-route";

describe("isAssistantSurface", () => {
  it("treats the chat home /dashboard as the assistant (full-height, pinned composer) surface", () => {
    expect(isAssistantSurface("/dashboard")).toBe(true);
  });

  it("no longer treats the retired /ai application as a chat surface", () => {
    // /ai and its section pages are compatibility redirects to /dashboard now;
    // nothing renders the pinned-composer chat at those addresses any more.
    expect(isAssistantSurface("/ai")).toBe(false);
    expect(isAssistantSurface("/ai/agents")).toBe(false);
    expect(isAssistantSurface("/ai/coworkers")).toBe(false);
  });

  it("is false for unrelated pages, including the retired quick-report dashboard", () => {
    expect(isAssistantSurface("/overview")).toBe(false);
    expect(isAssistantSurface("/media")).toBe(false);
    expect(isAssistantSurface("/projects")).toBe(false);
    expect(isAssistantSurface("/accounting/overview")).toBe(false);
  });
});
