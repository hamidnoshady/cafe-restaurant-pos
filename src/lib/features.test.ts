import { describe, expect, it } from "vitest";
import { featureForApiPath, featureForPagePath } from "./features";

describe("featureForApiPath", () => {
  it("maps a gated prefix and its sub-paths to the right flag", () => {
    expect(featureForApiPath("/api/inventory")).toBe("inventory");
    expect(featureForApiPath("/api/inventory/purchases/123")).toBe("inventory");
    expect(featureForApiPath("/api/ledger/entries/drafts")).toBe("ledger");
    expect(featureForApiPath("/api/reports/standard/cash_flow")).toBe("reporting");
    expect(featureForApiPath("/api/ai/chat")).toBe("ai_assistant");
  });

  it("maps floor/table routes to reservations, matching the flag's own description", () => {
    expect(featureForApiPath("/api/tables")).toBe("reservations");
    expect(featureForApiPath("/api/table-sessions/abc")).toBe("reservations");
    expect(featureForApiPath("/api/floor/sections")).toBe("reservations");
  });

  it("leaves /api/locations ungated — core branch-resolution plumbing every session needs", () => {
    expect(featureForApiPath("/api/locations/active")).toBeNull();
  });

  it("leaves unmapped prefixes (auth, team, setup, …) ungated", () => {
    expect(featureForApiPath("/api/auth/login")).toBeNull();
    expect(featureForApiPath("/api/team")).toBeNull();
    expect(featureForApiPath("/api/setup/state")).toBeNull();
  });

  it("does not false-positive on a prefix that merely starts with the same characters", () => {
    expect(featureForApiPath("/api/ledgerish")).toBeNull();
  });
});

describe("featureForPagePath", () => {
  it("maps gated dashboard pages to their flag", () => {
    expect(featureForPagePath("/dashboard/inventory")).toBe("inventory");
    expect(featureForPagePath("/dashboard/branches")).toBe("multi_location");
    expect(featureForPagePath("/dashboard/locations")).toBe("offline_mode");
    expect(featureForPagePath("/dashboard/waiter")).toBe("reservations");
  });

  it("leaves ungated pages (dashboard home, kitchen, pos, team, …) alone", () => {
    expect(featureForPagePath("/dashboard")).toBeNull();
    expect(featureForPagePath("/dashboard/kitchen")).toBeNull();
    expect(featureForPagePath("/dashboard/pos")).toBeNull();
    expect(featureForPagePath("/dashboard/team")).toBeNull();
  });
});
