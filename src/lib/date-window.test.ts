/**
 * The window maths both the CRM and Growth overviews count over.
 *
 * These cases came from `crm-shared.test.ts` and `growth-shared.test.ts`, which
 * each tested their own identical copy of `rollingWindow`. One implementation
 * now, so one suite proves it — and the leap-day and no-overlap cases the CRM
 * had written are no longer cases only one of the two apps was covered for.
 */

import { describe, expect, it } from "vitest";
import { previousWindow, rollingWindow } from "./date-window";

describe("rollingWindow / previousWindow", () => {
  it("builds an inclusive rolling window ending today", () => {
    expect(rollingWindow("2026-03-10", 30)).toEqual({ from: "2026-02-09", to: "2026-03-10" });
    expect(rollingWindow("2026-03-10", 1)).toEqual({ from: "2026-03-10", to: "2026-03-10" });
  });

  it("crosses a month and a leap day correctly", () => {
    expect(rollingWindow("2028-03-01", 2)).toEqual({ from: "2028-02-29", to: "2028-03-01" });
  });

  it("returns the immediately preceding window of the same length", () => {
    const current = rollingWindow("2026-03-10", 30);
    const prior = previousWindow(current);
    expect(prior.to).toBe("2026-02-08");
    expect(prior).toEqual({ from: "2026-01-10", to: "2026-02-08" });
  });

  it("never overlaps the current window", () => {
    // An overlap would let the same order count as both «این دوره» and
    // «دورهٔ قبل», making every trend arrow lie.
    for (const days of [1, 7, 30, 90, 365]) {
      const current = rollingWindow("2026-03-10", days);
      const prior = previousWindow(current);
      expect(prior.to < current.from).toBe(true);
    }
  });

  it("gives the prior window the same length as the current one", () => {
    for (const days of [7, 30, 90]) {
      const current = rollingWindow("2026-03-10", days);
      const prior = previousWindow(current);
      const length = (from: string, to: string) =>
        Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
      expect(length(prior.from, prior.to)).toBe(length(current.from, current.to));
    }
  });
});

describe("rollingWindow across a leap February", () => {
  it("keeps the 30-day span the Growth dashboard reads", () => {
    // These two came from `growth-shared.test.ts`, which proved them against a
    // second copy of the same function.
    expect(rollingWindow("2024-03-15")).toEqual({ from: "2024-02-15", to: "2024-03-15" });
    expect(rollingWindow("2026-03-01")).toEqual({ from: "2026-01-31", to: "2026-03-01" });
  });

  it("defaults to 30 days", () => {
    expect(rollingWindow("2026-08-28")).toEqual(rollingWindow("2026-08-28", 30));
  });
});
