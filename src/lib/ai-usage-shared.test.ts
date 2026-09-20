import { describe, expect, it } from "vitest";
import {
  AI_USAGE_REQUEST_TYPES,
  AI_USAGE_REQUEST_TYPE_LABELS,
  AI_USAGE_WINDOWS,
  cacheHitRate,
  normalizeRequestType,
  normalizeWindowDays,
  requestTypeLabel,
} from "./ai-usage-shared";

describe("Phase I — AI usage shared core", () => {
  it("labels every known request type", () => {
    for (const type of AI_USAGE_REQUEST_TYPES) {
      const label = AI_USAGE_REQUEST_TYPE_LABELS[type];
      expect(label, `label for ${type}`).toBeTruthy();
      // A label is a human name, never the raw key echoed back.
      expect(label).not.toBe(type);
    }
  });

  it("buckets an unknown or missing request type into `other`", () => {
    expect(normalizeRequestType("chat")).toBe("chat");
    expect(normalizeRequestType("coworker")).toBe("coworker");
    expect(normalizeRequestType("some_future_type")).toBe("other");
    expect(normalizeRequestType(null)).toBe("other");
    expect(normalizeRequestType(undefined)).toBe("other");
  });

  it("gives a Persian label for a raw or unknown origin", () => {
    expect(requestTypeLabel("agent")).toBe(AI_USAGE_REQUEST_TYPE_LABELS.agent);
    expect(requestTypeLabel("mystery")).toBe(AI_USAGE_REQUEST_TYPE_LABELS.other);
  });

  it("clamps the window to one of the offered values, defaulting to the first", () => {
    expect(normalizeWindowDays("7")).toBe(7);
    expect(normalizeWindowDays("30")).toBe(30);
    expect(normalizeWindowDays(90)).toBe(90);
    // Out-of-range, junk, or missing → the default window.
    expect(normalizeWindowDays("1")).toBe(AI_USAGE_WINDOWS[0]);
    expect(normalizeWindowDays("999")).toBe(AI_USAGE_WINDOWS[0]);
    expect(normalizeWindowDays("abc")).toBe(AI_USAGE_WINDOWS[0]);
    expect(normalizeWindowDays(null)).toBe(AI_USAGE_WINDOWS[0]);
    expect(normalizeWindowDays(undefined)).toBe(AI_USAGE_WINDOWS[0]);
  });

  it("computes the cache-hit rate and guards the zero-turn case", () => {
    expect(cacheHitRate({ cacheHits: 0, totalTurns: 0 })).toBe(0);
    expect(cacheHitRate({ cacheHits: 3, totalTurns: 12 })).toBeCloseTo(0.25);
    expect(cacheHitRate({ cacheHits: 5, totalTurns: 5 })).toBe(1);
  });
});
