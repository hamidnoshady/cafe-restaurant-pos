import { describe, expect, it } from "vitest";

import {
  cmsDnsHint,
  cmsTargetUnknown,
  dnsHint,
  ipsOverlap,
  isSiteLive,
  pointsElsewhere,
  type DnsCheck,
} from "./dns";

describe("ipsOverlap", () => {
  it("is true when one address is shared (CNAME to the CMS)", () => {
    expect(ipsOverlap(["203.0.113.10", "203.0.113.20"], ["203.0.113.10"])).toBe(true);
    expect(ipsOverlap(["2001:db8::1"], ["2001:db8::1", "203.0.113.10"])).toBe(true);
  });

  it("is false when the sets are disjoint", () => {
    expect(ipsOverlap(["203.0.113.10"], ["198.51.100.7"])).toBe(false);
  });

  it("does not care about case or order", () => {
    expect(ipsOverlap(["2001:DB8::1"], ["2001:db8::1"])).toBe(true);
    expect(ipsOverlap(["1.2.3.4", "5.6.7.8"], ["5.6.7.8"])).toBe(true);
  });

  it("handles empty sets", () => {
    expect(ipsOverlap([], [])).toBe(false);
    expect(ipsOverlap(["1.2.3.4"], [])).toBe(false);
  });
});

const base: DnsCheck = {
  domain: "acme.ir",
  resolved: true,
  pointingToCms: true,
  cmsHost: "cms.eshobe.com",
  domainAddresses: ["203.0.113.10"],
  cmsAddresses: ["203.0.113.10"],
};

describe("dnsHint", () => {
  it("names the owner's own domain when it has no record — never the CMS host", () => {
    // The whole point of the first step is "go to *your* registrar and add a
    // record for *your* domain". Naming cms.eshobe.com there sent owners to
    // the wrong panel looking for a record that was never theirs.
    const hint = dnsHint({ ...base, resolved: false, pointingToCms: false, domainAddresses: [] });
    expect(hint).toContain("acme.ir");
    expect(hint).not.toContain("cms.eshobe.com");
    expect(hint).toContain("رکورد A");
  });

  it("explains the wrong-target step with the CMS addresses to copy", () => {
    const hint = dnsHint({ ...base, pointingToCms: false, domainAddresses: ["198.51.100.7"] });
    expect(hint).toContain("203.0.113.10");
    expect(hint).toContain("acme.ir");
  });

  it("does not blame the owner when our own CMS host failed to resolve", () => {
    // cmsAddresses empty ⇒ ipsOverlap is false for a reason that has nothing
    // to do with the customer's records; telling them to edit DNS is wrong.
    const check = { ...base, pointingToCms: false, cmsAddresses: [] };
    expect(cmsTargetUnknown(check)).toBe(true);
    expect(pointsElsewhere(check)).toBe(false);
    const hint = dnsHint(check);
    expect(hint).toContain("دوباره");
    expect(hint).not.toContain("رکورد A را روی");
  });

  it("flags when everything is pointed correctly", () => {
    expect(dnsHint(base)).toContain("تأیید دامنه");
  });
});

describe("cmsDnsHint", () => {
  it("asks for the operator's tick once DNS is right", () => {
    expect(cmsDnsHint({ dns: base, domainVerified: false })).toContain("تأیید دامنه");
  });

  it("separates «not verified yet» from «we could not read the descriptor»", () => {
    // Both used to render the same sentence, which told an owner to go tick a
    // box that may well already be ticked.
    const unknown = cmsDnsHint({ dns: base, domainVerified: null });
    const notYet = cmsDnsHint({ dns: base, domainVerified: false });
    expect(unknown).not.toBe(notYet);
    expect(unknown).toContain("خوانده نشد");
  });

  it("says the site is live only when all three facts hold", () => {
    expect(cmsDnsHint({ dns: base, domainVerified: true })).toContain("فعال است");
  });
});

describe("isSiteLive", () => {
  it("is true only when DNS resolves, points at the CMS and the domain is verified", () => {
    expect(isSiteLive({ dns: base, domainVerified: true })).toBe(true);
    expect(isSiteLive({ dns: base, domainVerified: false })).toBe(false);
    // An unreadable descriptor is not a live site: the preview would embed a
    // page the CMS may refuse to serve on that host.
    expect(isSiteLive({ dns: base, domainVerified: null })).toBe(false);
    expect(isSiteLive({ dns: { ...base, pointingToCms: false }, domainVerified: true })).toBe(false);
    expect(isSiteLive({ dns: { ...base, resolved: false }, domainVerified: true })).toBe(false);
  });
});
