import { describe, expect, it } from "vitest";
import { CAPABILITIES_FOR } from "@/lib/platform-admin";
import { businessSections } from "./sections";

const BUSINESS_ID = "business-1";

function labelsFor(role: "support" | "engineer" | "owner") {
  return businessSections(BUSINESS_ID, CAPABILITIES_FOR(role)).map((section) => section.label);
}

describe("business workspace navigation", () => {
  it("gives the owner each distinct detail section beneath the selected business", () => {
    const sections = businessSections(BUSINESS_ID, CAPABILITIES_FOR("owner"));
    const hrefs = sections.map((section) => section.href);

    // Migration 0176: the `plan` section is gone — it redirects into the
    // consolidated commercial section (`billing?tab=subscription`).
    expect(hrefs).toEqual([
      "/platform/businesses/business-1",
      "/platform/businesses/business-1/settings",
      "/platform/businesses/business-1/billing",
      "/platform/businesses/business-1/features",
      "/platform/businesses/business-1/support",
      "/platform/businesses/business-1/danger",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("shows the consolidated billing section to every admin (billing.view) while hiding destructive entries", () => {
    const support = labelsFor("support");
    expect(support).toContain("تنظیمات کسب‌وکار");
    expect(support).toContain("برنامه‌ها و قابلیت‌ها");
    expect(support).toContain("دسترسی پشتیبانی");
    // Billing reads ride `billing.view`, which every role holds; the write
    // actions inside the page are re-checked server-side per capability.
    expect(support).toContain("صورت‌حساب و اشتراک");
    expect(support).not.toContain("منطقهٔ خطر");

    const engineer = labelsFor("engineer");
    expect(engineer).toContain("صورت‌حساب و اشتراک");
    expect(engineer).not.toContain("منطقهٔ خطر");
  });

  it("shows the destructive entry only to the role that holds an eligible destructive capability", () => {
    // Visibility is only UI honesty; platform API tests separately assert the
    // server-side capability guards. This makes the detail menu match, rather
    // than replace, that boundary.
    expect(labelsFor("owner")).toContain("منطقهٔ خطر");
    expect(labelsFor("support")).not.toContain("منطقهٔ خطر");
    expect(labelsFor("engineer")).not.toContain("منطقهٔ خطر");
  });
});
