import { describe, expect, it } from "vitest";
import { resolveDeploymentProfile } from "./deployment-mode";

describe("deployment profile migration adapter", () => {
  it("maps legacy connected by runtime role without confusing role and profile", () => {
    expect(resolveDeploymentProfile({ mode: "connected", pairedAt: "x" }, "site")).toEqual({ profile: "hybrid", pairedAt: "x", source: "legacy" });
    expect(resolveDeploymentProfile({ mode: "connected" }, "central").profile).toBe("cloud");
  });
  it("infers old central tenants as cloud and unpaired sites as local", () => {
    expect(resolveDeploymentProfile(null, "central").profile).toBe("cloud");
    expect(resolveDeploymentProfile(null, "site").profile).toBe("local");
  });
  it("prefers the explicit new profile", () => {
    expect(resolveDeploymentProfile({ profile: "hybrid", pairedAt: null }, "central")).toMatchObject({ profile: "hybrid", source: "profile" });
  });
});
