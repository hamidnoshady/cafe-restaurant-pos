import { describe, expect, it } from "vitest";
import { runTenantScopedProactiveJobs } from "./ai-proactive-service";

describe("proactive AI tenant loop", () => {
  it("enters each business through the tenant wrapper and continues after a failure", async () => {
    const events: string[] = [];
    const result = await runTenantScopedProactiveJobs(
      ["alpha", "beta", "gamma"],
      async (businessId, work) => {
        events.push(`enter:${businessId}`);
        await work();
        events.push(`leave:${businessId}`);
      },
      async (businessId) => {
        events.push(`work:${businessId}`);
        if (businessId === "beta") throw new Error("one tenant failed");
      },
    );

    expect(result).toEqual({ completed: 2, failed: 1 });
    expect(events).toEqual([
      "enter:alpha",
      "work:alpha",
      "leave:alpha",
      "enter:beta",
      "work:beta",
      "enter:gamma",
      "work:gamma",
      "leave:gamma",
    ]);
  });
});
