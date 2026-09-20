import { describe, expect, it } from "vitest";
import { computeUpdateAvailable } from "./app-update-status";

describe("computeUpdateAvailable", () => {
  it("is false when the versions match", () => {
    expect(computeUpdateAvailable("abc1234", "abc1234")).toBe(false);
  });

  it("is true when the remote reports a different version", () => {
    expect(computeUpdateAvailable("abc1234", "def5678")).toBe(true);
  });

  it("is false when the remote's version is unknown (no build-arg was set)", () => {
    expect(computeUpdateAvailable("abc1234", "unknown")).toBe(false);
  });

  it("is false when both sides are unknown", () => {
    expect(computeUpdateAvailable("unknown", "unknown")).toBe(false);
  });
});
