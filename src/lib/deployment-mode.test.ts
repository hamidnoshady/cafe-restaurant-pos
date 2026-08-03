import { describe, expect, it } from "vitest";
import { LOCAL_DISABLED_FEATURES, resolveDeploymentMode } from "./deployment-mode";

describe("resolveDeploymentMode", () => {
  it("treats an absent setting as connected, so installs predating this feature are unaffected", () => {
    expect(resolveDeploymentMode(null)).toEqual({ mode: "connected", pairedAt: null });
    expect(resolveDeploymentMode(undefined)).toEqual({ mode: "connected", pairedAt: null });
  });

  it("reads a stored local mode", () => {
    expect(resolveDeploymentMode({ mode: "local", pairedAt: null })).toEqual({
      mode: "local",
      pairedAt: null,
    });
  });

  it("keeps the paired timestamp on a connected install", () => {
    expect(resolveDeploymentMode({ mode: "connected", pairedAt: "2026-08-03T10:00:00.000Z" })).toEqual(
      { mode: "connected", pairedAt: "2026-08-03T10:00:00.000Z" },
    );
  });

  it("falls back to connected for a malformed value rather than locking features off", () => {
    expect(resolveDeploymentMode({ mode: "banana" })).toEqual({ mode: "connected", pairedAt: null });
    expect(resolveDeploymentMode("local")).toEqual({ mode: "connected", pairedAt: null });
    expect(resolveDeploymentMode(42)).toEqual({ mode: "connected", pairedAt: null });
  });

  it("drops a non-string pairedAt", () => {
    expect(resolveDeploymentMode({ mode: "local", pairedAt: 12345 })).toEqual({
      mode: "local",
      pairedAt: null,
    });
  });
});

describe("LOCAL_DISABLED_FEATURES", () => {
  it("disables exactly the three platform-dependent features", () => {
    expect([...LOCAL_DISABLED_FEATURES].sort()).toEqual([
      "ai_assistant",
      "multi_location",
      "offline_mode",
    ]);
  });

  it("leaves the fully-local features alone", () => {
    for (const key of ["backup", "inventory", "ledger", "reservations", "delivery", "reporting"]) {
      expect(LOCAL_DISABLED_FEATURES).not.toContain(key);
    }
  });
});
