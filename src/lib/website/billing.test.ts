import { describe, expect, it } from "vitest";
import {
  addMonths,
  isRenewalDue,
  plansForSiteType,
  quoteToRial,
  renewalAmountRial,
  subscriptionReference,
  totalChargedRial,
  WEBSITE_CHARGE_KINDS,
  WEBSITE_CHARGE_LABELS,
  WEBSITE_SUBSCRIPTION_STATUS_LABELS,
  WEBSITE_SUBSCRIPTION_STATUSES,
  type WebsiteCharge,
  type WebsitePlan,
  type WebsiteSubscription,
} from "./billing";

const plan = (patch: Partial<WebsitePlan> = {}): WebsitePlan => ({
  key: "site_starter",
  name: "سایت پایه",
  description: null,
  monthlyPriceRial: 2_000_000,
  setupPriceRial: 0,
  siteTypes: [],
  includesCdn: true,
  includesDomain: false,
  maxProducts: null,
  maxPages: 20,
  isActive: true,
  sortOrder: 10,
  ...patch,
});

const subscription = (patch: Partial<WebsiteSubscription> = {}): WebsiteSubscription => ({
  planKey: "site_starter",
  status: "active",
  startedAt: "2026-01-15T09:00:00.000Z",
  currentPeriodStart: "2026-01-15T09:00:00.000Z",
  currentPeriodEnd: "2026-02-15T09:00:00.000Z",
  autoRenew: true,
  cancelledAt: null,
  monthlyPriceRial: 2_000_000,
  ...patch,
});

describe("labels", () => {
  it("names every charge kind and every subscription status in Persian", () => {
    for (const kind of WEBSITE_CHARGE_KINDS) {
      expect(WEBSITE_CHARGE_LABELS[kind].trim().length).toBeGreaterThan(0);
    }
    for (const status of WEBSITE_SUBSCRIPTION_STATUSES) {
      expect(WEBSITE_SUBSCRIPTION_STATUS_LABELS[status].trim().length).toBeGreaterThan(0);
    }
  });
});

describe("plansForSiteType", () => {
  it("keeps a plan with no declared types — it fits every site", () => {
    expect(plansForSiteType([plan()], "store").map((row) => row.key)).toEqual(["site_starter"]);
  });

  it("narrows to the plans that name this type, and drops inactive rows", () => {
    const store = plan({ key: "site_store", siteTypes: ["store"], sortOrder: 20 });
    const retired = plan({ key: "old", siteTypes: ["store"], isActive: false });
    expect(plansForSiteType([store, retired], "store").map((row) => row.key)).toEqual(["site_store"]);
    expect(plansForSiteType([store, retired], "portfolio")).toEqual([]);
  });

  it("sorts by the operator's order, then by key", () => {
    const a = plan({ key: "b", sortOrder: 5 });
    const b = plan({ key: "a", sortOrder: 5 });
    const c = plan({ key: "c", sortOrder: 1 });
    expect(plansForSiteType([a, b, c], "business").map((row) => row.key)).toEqual(["c", "a", "b"]);
  });
});

describe("addMonths", () => {
  it("advances one month and keeps the day of the month", () => {
    expect(addMonths("2026-01-15T09:00:00.000Z", 1)).toBe("2026-02-15T09:00:00.000Z");
  });

  it("clamps to the end of a shorter month instead of rolling into the next one", () => {
    // The 31st has no counterpart in February; rolling over would move a
    // business's billing anniversary forward for good.
    expect(addMonths("2026-01-31T09:00:00.000Z", 1)).toBe("2026-02-28T09:00:00.000Z");
    expect(addMonths("2026-03-31T09:00:00.000Z", 1)).toBe("2026-04-30T09:00:00.000Z");
  });

  it("crosses a year boundary", () => {
    expect(addMonths("2026-12-10T00:00:00.000Z", 1)).toBe("2027-01-10T00:00:00.000Z");
  });
});

describe("subscriptionReference", () => {
  it("is built from the period, so a retry lands on the same key", () => {
    const first = subscriptionReference("2026-01-15T09:00:00.000Z");
    const retry = subscriptionReference("2026-01-15T23:59:00.000Z");
    expect(first).toBe(retry);
    expect(first).toBe("period:2026-01-15");
  });

  it("differs between consecutive periods", () => {
    expect(subscriptionReference("2026-01-15T09:00:00.000Z")).not.toBe(
      subscriptionReference("2026-02-15T09:00:00.000Z"),
    );
  });
});

describe("isRenewalDue", () => {
  it("is due once the period has ended", () => {
    expect(isRenewalDue(subscription(), "2026-02-16T00:00:00.000Z")).toBe(true);
    expect(isRenewalDue(subscription(), "2026-02-01T00:00:00.000Z")).toBe(false);
  });

  it("is never due for a cancelled subscription or one with auto-renew off", () => {
    expect(isRenewalDue(subscription({ autoRenew: false }), "2026-03-01T00:00:00.000Z")).toBe(false);
    expect(isRenewalDue(subscription({ status: "cancelled" }), "2026-03-01T00:00:00.000Z")).toBe(false);
  });

  it("charges the price agreed at subscribe time, not the catalogue's current one", () => {
    expect(renewalAmountRial(subscription({ monthlyPriceRial: 1_500_000 }))).toBe(1_500_000);
  });
});

describe("quoteToRial", () => {
  it("passes a Rial quote through and multiplies a Toman one by ten", () => {
    expect(quoteToRial(250_000, "IRR")).toBe(250_000);
    expect(quoteToRial(250_000, "IRT")).toBe(2_500_000);
  });

  it("refuses a foreign currency rather than guessing a rate", () => {
    // Charging a business a number nobody can reconcile is worse than saying
    // the platform cannot sell them that TLD yet.
    expect(quoteToRial(20, "USD")).toBeNull();
    expect(quoteToRial(20, "EUR")).toBeNull();
  });

  it("refuses a nonsense figure", () => {
    expect(quoteToRial(-1, "IRR")).toBeNull();
    expect(quoteToRial(Number.NaN, "IRR")).toBeNull();
  });
});

describe("totalChargedRial", () => {
  it("adds the charges up in integer Rial", () => {
    const charge = (amountRial: number): WebsiteCharge => ({
      id: `${amountRial}`,
      kind: "subscription",
      description: "",
      amountRial,
      occurredAt: "2026-01-15T09:00:00.000Z",
      periodStart: null,
      periodEnd: null,
      reference: `r${amountRial}`,
    });
    expect(totalChargedRial([charge(2_000_000), charge(500_000)])).toBe(2_500_000);
    expect(totalChargedRial([])).toBe(0);
  });
});
