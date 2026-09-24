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

    expect(hrefs).toEqual([
      "/platform/businesses/business-1",
      "/platform/businesses/business-1/settings",
      "/platform/businesses/business-1/plan",
      "/platform/businesses/business-1/billing",
      "/platform/businesses/business-1/features",
      "/platform/businesses/business-1/support",
      "/platform/businesses/business-1/danger",
    ]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("hides a capability-gated billing and destructive entry without removing the safe detail IA", () => {
    const support = labelsFor("support");
    expect(support).toContain("تنظیمات کسب‌وکار");
    expect(support).toContain("برنامه‌ها و قابلیت‌ها");
    expect(support).toContain("دسترسی پشتیبانی");
    expect(support).not.toContain("صورت‌حساب و پرداخت");
    expect(support).not.toContain("منطقهٔ خطر");

    const engineer = labelsFor("engineer");
    expect(engineer).toContain("صورت‌حساب و پرداخت");
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
