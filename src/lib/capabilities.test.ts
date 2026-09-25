import { describe, expect, it } from "vitest";
import { capabilityForApiPath, resolveCapability } from "./capabilities";

describe("deployment capability resolver", () => {
  it("keeps accounting and CRM available in all profiles", () => {
    for (const deployment of ["cloud", "hybrid", "local"] as const) {
      expect(resolveCapability("app.accounting", { deployment }).status).toBe("available");
      expect(resolveCapability("app.crm", { deployment }).status).toBe("available");
    }
  });

  it("distinguishes cloud activation from plan entitlement", () => {
    expect(resolveCapability("app.ai", { deployment: "local", entitlements: { ai_assistant: false } })).toMatchObject({
      status: "requires_cloud", code: "REQUIRES_CLOUD_CONNECTION",
    });
    expect(resolveCapability("app.ai", { deployment: "hybrid", entitlements: { ai_assistant: false } })).toMatchObject({
      status: "unavailable_by_plan", code: "FEATURE_NOT_IN_PLAN",
    });
  });

  it("does not confuse a Hybrid Internet outage with local operational failure", () => {
    expect(resolveCapability("app.growth", { deployment: "hybrid", runtime: { internet: "unreachable" } }).status).toBe("requires_internet");
    expect(resolveCapability("app.accounting", { deployment: "hybrid", runtime: { internet: "unreachable" } }).status).toBe("available");
  });

  it("makes Support and Bug Report the only Local cloud exceptions", () => {
    expect(resolveCapability("app.support", { deployment: "local" }).status).toBe("available");
    expect(resolveCapability("support.bug_report", { deployment: "local" }).status).toBe("available");
    expect(resolveCapability("app.support", { deployment: "local", runtime: { internet: "unreachable" } })).toMatchObject({
      status: "requires_internet", code: "INTERNET_REQUIRED",
    });

    for (const capability of [
      "app.ai", "app.website", "app.growth", "app.workspace", "platform.billing",
      "cloud.integrations", "cloud.sync", "cloud.multi_location", "cloud.messaging",
    ] as const) {
      expect(resolveCapability(capability, { deployment: "local" })).toMatchObject({
        status: "requires_cloud", code: "REQUIRES_CLOUD_CONNECTION",
      });
    }
  });

  it("maps cloud API families and Local exceptions to the same registry", () => {
    expect(capabilityForApiPath("/api/cms/website/posts")).toBe("app.website");
    expect(capabilityForApiPath("/api/website/posts")).toBe("app.website");
    expect(capabilityForApiPath("/api/ai/chat")).toBe("app.ai");
    expect(capabilityForApiPath("/api/workspace/items")).toBe("app.workspace");
    expect(capabilityForApiPath("/api/support/tickets")).toBe("app.support");
    expect(capabilityForApiPath("/api/bug-report")).toBe("support.bug_report");
    expect(capabilityForApiPath("/api/orders")).toBeNull();
  });
});
