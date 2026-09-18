import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_CHANNELS,
  CAMPAIGN_CHANNEL_LABELS,
  contactFor,
  isCampaignChannel,
  summarizeAudience as summarize,
  summarizeAudienceCounts,
  unreachableForLackOfContact,
} from "./campaign-channels";
import type { SegmentMember } from "./crm-segments-service";

function member(over: Partial<SegmentMember> = {}): SegmentMember {
  return {
    id: "c1",
    name: "مریم رضایی",
    phone: "09121234567",
    phoneE164: "+989121234567",
    email: "maryam@example.com",
    tags: [],
    smsConsent: true,
    marketingConsent: true,
    isActive: true,
    lastPurchaseDate: "2026-08-01",
    orderCount: 3,
    totalSpentRial: 1_500_000,
    lifecycleStage: "champion",
    ...over,
  };
}

describe("campaign audience", () => {
  it("reports how many people consent removed, because a silently shrunken list looks like a bug", () => {
    const matched = [
      member({ id: "a" }),
      member({ id: "b" }),
      member({ id: "c" }),
    ];
    const reachable = [member({ id: "a" })];

    const audience = summarize("sms", matched, reachable, 5000);

    expect(audience.matched).toBe(3);
    expect(audience.reachable).toBe(1);
    expect(audience.excludedByConsent).toBe(2);
  });

  it("never reports a negative exclusion count", () => {
    // Should be impossible — consent only narrows — but if the two queries ever
    // disagreed, "-2 excluded" on screen is worse than 0.
    const audience = summarize("sms", [member()], [member(), member()], 5000);
    expect(audience.excludedByConsent).toBe(0);
  });

  it("flags truncation so a caller cannot mistake the page for the audience", () => {
    const reachable = Array.from({ length: 10 }, (_, i) =>
      member({ id: `c${i}` }),
    );

    const capped = summarize("sms", reachable, reachable, 4);
    expect(capped.members).toHaveLength(4);
    expect(capped.reachable).toBe(10);
    expect(capped.truncated).toBe(true);

    const whole = summarize("sms", reachable, reachable, 50);
    expect(whole.truncated).toBe(false);
  });

  it("keeps full database counts even when the member sample is capped", () => {
    const members = Array.from({ length: 4 }, (_, i) =>
      member({ id: `c${i}` }),
    );
    const audience = summarizeAudienceCounts("sms", 1350, 1200, members, 4);

    expect(audience.matched).toBe(1350);
    expect(audience.reachable).toBe(1200);
    expect(audience.members).toHaveLength(4);
    expect(audience.truncated).toBe(true);
  });

  it("prefers the normalised phone for SMS and falls back to the raw one", () => {
    expect(contactFor(member(), "sms")).toBe("+989121234567");
    expect(contactFor(member({ phoneE164: null }), "sms")).toBe("09121234567");
    expect(
      contactFor(member({ phoneE164: null, phone: null }), "sms"),
    ).toBeNull();
  });

  it("treats a blank email as no email", () => {
    expect(contactFor(member(), "email")).toBe("maryam@example.com");
    expect(contactFor(member({ email: "   " }), "email")).toBeNull();
    expect(contactFor(member({ email: null }), "email")).toBeNull();
  });

  it("separates 'consented but unreachable' from 'refused', since the fix differs", () => {
    // Consent granted, no address on file: a data-quality problem the owner can
    // fix by asking. Lumping it in with refusals would hide it forever.
    const members = [
      member({ id: "ok" }),
      member({ id: "no-phone", phone: null, phoneE164: null }),
    ];
    const stuck = unreachableForLackOfContact(members, "sms");
    expect(stuck.map((m) => m.id)).toEqual(["no-phone"]);
  });

  it("recognises exactly the channels it can enforce consent for", () => {
    expect(isCampaignChannel("sms")).toBe(true);
    expect(isCampaignChannel("email")).toBe(true);
    // "view" is a segment purpose meaning *no consent filtering*. If it ever
    // became accepted as a channel, a send would reach people who refused.
    expect(isCampaignChannel("view")).toBe(false);
    expect(isCampaignChannel("push")).toBe(false);
    expect(isCampaignChannel(undefined)).toBe(false);
  });

  it("labels every channel in Persian", () => {
    for (const channel of CAMPAIGN_CHANNELS) {
      expect(CAMPAIGN_CHANNEL_LABELS[channel]).toBeTruthy();
      expect(CAMPAIGN_CHANNEL_LABELS[channel]).not.toMatch(/[A-Za-z]/);
    }
  });
});
