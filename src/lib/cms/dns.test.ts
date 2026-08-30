import { describe, expect, it } from "vitest";

import { dnsHint, ipsOverlap, type DnsCheck } from "./dns";

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

describe("dnsHint", () => {
  const base: DnsCheck = {
    resolved: true,
    pointingToCms: true,
    cmsHost: "cms.eshobe.com",
    domainAddresses: ["203.0.113.10"],
    cmsAddresses: ["203.0.113.10"],
  };

  it("explains the not-resolved step", () => {
    expect(dnsHint({ ...base, resolved: false, pointingToCms: false })).toContain("رکورد A/CNAME");
  });

  it("explains the wrong-target step with the CMS addresses", () => {
    expect(dnsHint({ ...base, pointingToCms: false, cmsAddresses: ["203.0.113.10"] })).toContain("203.0.113.10");
  });

  it("flags when everything is pointed correctly", () => {
    expect(dnsHint(base)).toContain("تأیید دامنه");
  });
});
