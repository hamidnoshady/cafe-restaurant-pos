import { describe, expect, it } from "vitest";
import {
  accountBalance,
  campaignStateCounts,
  classifyCampaign,
  GROWTH_BRIDGE_CODES,
  rollingWindow,
} from "./growth-shared";
import { WELL_KNOWN_CODES } from "./coa-template";

describe("classifyCampaign", () => {
  const today = "2026-08-28";

  it("is live inside its window, on both boundary days", () => {
    // Inclusive bounds are the engine's own convention (promotions.ts).
    expect(classifyCampaign({ isActive: true, activeFrom: "2026-08-01", activeTo: "2026-08-28" }, today)).toBe("live");
    expect(classifyCampaign({ isActive: true, activeFrom: "2026-08-28", activeTo: "2026-09-30" }, today)).toBe("live");
  });

  it("is scheduled before its window opens, ended after it closes", () => {
    expect(classifyCampaign({ isActive: true, activeFrom: "2026-08-29", activeTo: null }, today)).toBe("scheduled");
    expect(classifyCampaign({ isActive: true, activeFrom: null, activeTo: "2026-08-27" }, today)).toBe("ended");
  });

  it("is live with no window at all — the default campaign shape", () => {
    expect(classifyCampaign({ isActive: true, activeFrom: null, activeTo: null }, today)).toBe("live");
  });

  it("a paused campaign is paused even mid-window", () => {
    // «متوقف» is the stronger fact: a campaign switched off is not running.
    expect(classifyCampaign({ isActive: false, activeFrom: "2026-08-01", activeTo: "2026-12-31" }, today)).toBe(
      "paused",
    );
  });
});

describe("campaignStateCounts", () => {
  it("counts every state once", () => {
    const counts = campaignStateCounts(["live", "live", "scheduled", "ended", "paused", "live"]);
    expect(counts).toEqual({ live: 3, scheduled: 1, ended: 1, paused: 1 });
  });

  it("answers all zeros for an empty catalogue", () => {
    expect(campaignStateCounts([])).toEqual({ live: 0, scheduled: 0, ended: 0, paused: 0 });
  });
});

describe("accountBalance", () => {
  it("signs liabilities credit-normal, so an owed balance reads positive", () => {
    // 2410/2420/2300: credit 500k, debit 120k → the business owes 380k.
    expect(accountBalance("liability", 120_000, 500_000)).toBe(380_000);
  });

  it("signs expenses debit-normal, so spend reads positive", () => {
    // 5210: the commission charged to the books.
    expect(accountBalance("expense", 90_000, 0)).toBe(90_000);
  });

  it("keeps a contra-revenue account's credit-negative reading", () => {
    expect(accountBalance("revenue", 0, 40_000)).toBe(40_000);
  });
});

describe("rollingWindow", () => {
  it("spans exactly 30 inclusive days ending today", () => {
    expect(rollingWindow("2026-08-28")).toEqual({ from: "2026-07-30", to: "2026-08-28" });
  });

  it("crosses a month and a leap February without drifting", () => {
    expect(rollingWindow("2024-03-15")).toEqual({ from: "2024-02-15", to: "2024-03-15" });
    expect(rollingWindow("2026-03-01")).toEqual({ from: "2026-01-31", to: "2026-03-01" });
  });
});

describe("GROWTH_BRIDGE_CODES", () => {
  it("is exactly the four accounts the Growth app posts to, in code order", () => {
    // This list is the app's accounting connection; a change here is a product
    // decision and should be conscious.
    expect([...GROWTH_BRIDGE_CODES]).toEqual([
      WELL_KNOWN_CODES.salariesPayable,
      WELL_KNOWN_CODES.storeCreditPayable,
      WELL_KNOWN_CODES.giftCardPayable,
      WELL_KNOWN_CODES.commissionExpense,
    ]);
  });
});
