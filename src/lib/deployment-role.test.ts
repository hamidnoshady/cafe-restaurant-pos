import { describe, expect, it } from "vitest";
import { describeDeploymentRole, resolveDeploymentRole, resolvePlatformBaseUrl } from "./deployment-role";

describe("resolveDeploymentRole", () => {
  it("takes DEPLOYMENT_ROLE at its word when it is set", () => {
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "central" })).toEqual({ role: "central", source: "explicit" });
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "site" })).toEqual({ role: "site", source: "explicit" });
  });

  it("accepts it case-insensitively and with surrounding whitespace", () => {
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: " Central " }).role).toBe("central");
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "SITE" }).role).toBe("site");
  });

  it("declares an explicit site even when the central-server hints are present", () => {
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "site", POS_DOMAIN: "pos.eshobe.com" })).toEqual({
      role: "site",
      source: "explicit",
    });
  });

  it("infers central from REMOTE_SYNC_TOKEN or POS_DOMAIN, matching the pre-Phase-21 behaviour", () => {
    expect(resolveDeploymentRole({ REMOTE_SYNC_TOKEN: "secret" })).toEqual({ role: "central", source: "inferred" });
    expect(resolveDeploymentRole({ POS_DOMAIN: "pos.eshobe.com" })).toEqual({ role: "central", source: "inferred" });
  });

  it("infers site when nothing points at a central server", () => {
    expect(resolveDeploymentRole({})).toEqual({ role: "site", source: "inferred" });
  });

  it("treats blank and unrecognised values as unset rather than failing to boot", () => {
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "" })).toEqual({ role: "site", source: "inferred" });
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "   " })).toEqual({ role: "site", source: "inferred" });
    expect(resolveDeploymentRole({ DEPLOYMENT_ROLE: "centrall", POS_DOMAIN: "pos.eshobe.com" })).toEqual({
      role: "central",
      source: "inferred",
    });
  });

  it("does not read an empty env var as present", () => {
    expect(resolveDeploymentRole({ REMOTE_SYNC_TOKEN: "", POS_DOMAIN: "  " }).role).toBe("site");
  });
});

describe("resolvePlatformBaseUrl", () => {
  it("prefers PLATFORM_BASE_URL and strips trailing slashes", () => {
    expect(resolvePlatformBaseUrl({ PLATFORM_BASE_URL: "https://pos.eshobe.com/" })).toBe("https://pos.eshobe.com");
    expect(resolvePlatformBaseUrl({ PLATFORM_BASE_URL: "http://localhost:3000" })).toBe("http://localhost:3000");
  });

  it("falls back to POS_DOMAIN over https", () => {
    expect(resolvePlatformBaseUrl({ POS_DOMAIN: "pos.eshobe.com" })).toBe("https://pos.eshobe.com");
  });

  it("tolerates a POS_DOMAIN that was set with a scheme or a trailing slash anyway", () => {
    expect(resolvePlatformBaseUrl({ POS_DOMAIN: "https://pos.eshobe.com/" })).toBe("https://pos.eshobe.com");
  });

  it("ignores a PLATFORM_BASE_URL without a scheme and falls through", () => {
    expect(resolvePlatformBaseUrl({ PLATFORM_BASE_URL: "pos.eshobe.com", POS_DOMAIN: "other.example" })).toBe(
      "https://other.example",
    );
  });

  it("returns null when neither is set — the normal state on an unpaired site", () => {
    expect(resolvePlatformBaseUrl({})).toBe(null);
    expect(resolvePlatformBaseUrl({ PLATFORM_BASE_URL: "  " })).toBe(null);
  });
});

describe("describeDeploymentRole", () => {
  it("reports the role, where it came from, and the platform URL when there is one", () => {
    expect(describeDeploymentRole({ DEPLOYMENT_ROLE: "central", POS_DOMAIN: "pos.eshobe.com" })).toBe(
      "> deployment role: central (explicit), platform https://pos.eshobe.com",
    );
    expect(describeDeploymentRole({})).toBe("> deployment role: site (inferred)");
  });
});
