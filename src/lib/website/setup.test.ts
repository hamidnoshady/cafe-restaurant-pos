import { describe, expect, it } from "vitest";
import {
  buildReadiness,
  completedStepCount,
  currentStep,
  dnsInstruction,
  EMPTY_WEBSITE_SETUP,
  isStepComplete,
  isValidDomain,
  normalizeDomain,
  SITE_TYPE_LABELS,
  SITE_TYPES,
  tldOf,
  WEBSITE_SETUP_STEP_KEYS,
  WEBSITE_SETUP_STEPS,
  type WebsiteSetupState,
} from "./setup";

const state = (patch: Partial<WebsiteSetupState> = {}): WebsiteSetupState => ({
  ...EMPTY_WEBSITE_SETUP,
  ...patch,
});

describe("the four steps", () => {
  it("lists every step, exactly once, in the order the owner works in", () => {
    // «اول دامنه، بعد CDN، بعد نوع سایت، آخر ساخت.» A step reordered here
    // reorders the wizard, so the order is the assertion.
    expect(WEBSITE_SETUP_STEPS.map((step) => step.key)).toEqual([...WEBSITE_SETUP_STEP_KEYS]);
    expect(WEBSITE_SETUP_STEP_KEYS).toEqual(["domain", "cdn", "type", "build"]);
  });

  it("gives each step a title and a line of help", () => {
    for (const step of WEBSITE_SETUP_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.description.trim().length).toBeGreaterThan(0);
    }
  });

  it("names every site type in Persian", () => {
    for (const type of SITE_TYPES) {
      expect(SITE_TYPE_LABELS[type].trim().length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeDomain / isValidDomain", () => {
  it("strips the scheme, the path and a trailing dot, and lower-cases", () => {
    expect(normalizeDomain(" HTTPS://Acme.IR/shop ")).toBe("acme.ir");
    expect(normalizeDomain("acme.ir.")).toBe("acme.ir");
  });

  it("accepts a hostname and refuses everything that is not one", () => {
    expect(isValidDomain("acme.ir")).toBe(true);
    expect(isValidDomain("shop.acme.co.ir")).toBe(true);
    expect(isValidDomain("acme")).toBe(false);
    expect(isValidDomain("-acme.ir")).toBe(false);
    expect(isValidDomain("")).toBe(false);
  });

  it("reads the TLD, longest label after the last dot", () => {
    expect(tldOf("shop.acme.co.ir")).toBe("ir");
    expect(tldOf("acme")).toBe("");
  });
});

describe("isStepComplete", () => {
  it("counts a domain as answered once one is chosen, even while the registrar is still working", () => {
    // An owner buys a domain on Monday and it registers on Wednesday; the
    // wizard must let them get on with the other steps in between.
    expect(isStepComplete(state({ domain: "acme.ir", domainStatus: "ordered" }), "domain")).toBe(true);
    expect(isStepComplete(state({ domain: "acme.ir", domainStatus: "registered" }), "domain")).toBe(true);
  });

  it("does not count a failed domain order — there is no address to build on", () => {
    expect(isStepComplete(state({ domain: "acme.ir", domainStatus: "failed" }), "domain")).toBe(false);
  });

  it("treats «بدون CDN» as an answer, not as an unanswered step", () => {
    expect(isStepComplete(state({ cdnProvider: "none", cdnStatus: "skipped" }), "cdn")).toBe(true);
  });

  it("counts a requested CDN as answered — the zone is platform staff's work", () => {
    expect(isStepComplete(state({ cdnProvider: "arvancloud", cdnStatus: "requested" }), "cdn")).toBe(true);
    expect(isStepComplete(state({ cdnProvider: "arvancloud", cdnStatus: "pending" }), "cdn")).toBe(false);
  });

  it("wants a name as well as a type", () => {
    expect(isStepComplete(state({ siteType: "store" }), "type")).toBe(false);
    expect(isStepComplete(state({ siteType: "store", siteName: "فروشگاه اصفهان" }), "type")).toBe(true);
  });
});

describe("currentStep / completedStepCount", () => {
  it("opens on the first unfinished step", () => {
    expect(currentStep(state())).toBe("domain");
    expect(currentStep(state({ domain: "acme.ir" }))).toBe("cdn");
    expect(currentStep(state({ domain: "acme.ir", cdnStatus: "requested" }))).toBe("type");
    expect(
      currentStep(state({ domain: "acme.ir", cdnStatus: "requested", siteName: "کافه" })),
    ).toBe("build");
  });

  it("counts what is done, for the progress line on the app home", () => {
    expect(completedStepCount(state())).toBe(0);
    expect(completedStepCount(state({ domain: "acme.ir", cdnStatus: "requested" }))).toBe(2);
  });
});

describe("buildReadiness", () => {
  const ready = state({ domain: "acme.ir", cdnStatus: "requested", siteName: "کافه" });

  it("lets a complete wizard build", () => {
    expect(buildReadiness(ready)).toEqual({ ok: true });
  });

  it("refuses, with a reason the owner can act on, at each missing answer", () => {
    for (const missing of [
      state(),
      state({ domain: "acme.ir" }),
      state({ domain: "acme.ir", cdnStatus: "requested" }),
      state({ ...ready, domainStatus: "failed" }),
    ]) {
      const readiness = buildReadiness(missing);
      expect(readiness.ok).toBe(false);
      if (!readiness.ok) expect(readiness.reason.trim().length).toBeGreaterThan(0);
    }
  });

  it("refuses to build a second site for a business that already has one", () => {
    expect(buildReadiness({ ...ready, stage: "built" }).ok).toBe(false);
  });
});

describe("dnsInstruction", () => {
  it("hands over nameservers when a CDN fronts the site", () => {
    const instruction = dnsInstruction({
      domain: "acme.ir",
      cdnProvider: "arvancloud",
      cmsHost: "cms.eshobe.com",
      nameservers: ["ns1.arvancdn.ir", "ns2.arvancdn.ir"],
    });
    expect(instruction.kind).toBe("nameservers");
    expect(instruction.nameservers).toEqual(["ns1.arvancdn.ir", "ns2.arvancdn.ir"]);
  });

  it("falls back to records that point at the CMS itself", () => {
    const instruction = dnsInstruction({
      domain: "acme.ir",
      cdnProvider: "none",
      cmsHost: "cms.eshobe.com",
    });
    expect(instruction.kind).toBe("records");
    expect(instruction.records[0]).toEqual({ type: "CNAME", name: "acme.ir", value: "cms.eshobe.com" });
    expect(instruction.records[1]).toEqual({ type: "CNAME", name: "www.acme.ir", value: "acme.ir" });
  });

  it("prefers an A record when the CMS address is known", () => {
    const instruction = dnsInstruction({
      domain: "acme.ir",
      cdnProvider: "none",
      cmsHost: "cms.eshobe.com",
      cmsAddress: "185.10.0.1",
    });
    expect(instruction.records[0]).toEqual({ type: "A", name: "acme.ir", value: "185.10.0.1" });
  });
});
