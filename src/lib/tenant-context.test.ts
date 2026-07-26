import { describe, expect, it } from "vitest";
import {
  NO_SCOPE,
  businessScope,
  enterTenantScope,
  getTenantBusinessId,
  getTenantScope,
  runInTenantScope,
  scopeSettings,
} from "./tenant-context";

const BUSINESS_A = "11111111-1111-4111-8111-111111111111";
const BUSINESS_B = "22222222-2222-4222-8222-222222222222";

describe("scopeSettings", () => {
  it("maps a business scope to the tenant GUC", () => {
    expect(scopeSettings(businessScope(BUSINESS_A))).toEqual({
      businessId: BUSINESS_A,
      bypass: "",
    });
  });

  it("maps the absence of a scope to empty, never to a wildcard", () => {
    // This is the fail-closed contract: app_current_business() turns '' into
    // NULL, which makes every RLS policy predicate false. If this ever
    // returned something truthy, an unscoped request would read everything.
    expect(scopeSettings(NO_SCOPE)).toEqual({ businessId: "", bypass: "" });
  });

  it("maps a bypass scope to the bypass GUC and no business", () => {
    expect(scopeSettings({ kind: "bypass", reason: "login" })).toEqual({
      businessId: "",
      bypass: "on",
    });
  });

  it("never emits a business id together with bypass", () => {
    for (const scope of [
      businessScope(BUSINESS_A),
      NO_SCOPE,
      { kind: "bypass", reason: "platform" } as const,
    ]) {
      const settings = scopeSettings(scope);
      expect(settings.businessId === "" || settings.bypass === "").toBe(true);
    }
  });
});

describe("scope propagation", () => {
  it("reports no scope by default", () => {
    // Run inside an explicit empty scope so this doesn't depend on what other
    // tests in the file left behind.
    runInTenantScope(NO_SCOPE, () => {
      expect(getTenantScope().kind).toBe("none");
      expect(getTenantBusinessId()).toBeNull();
    });
  });

  it("exposes the business inside runInTenantScope and restores it afterwards", () => {
    runInTenantScope(businessScope(BUSINESS_A), () => {
      expect(getTenantBusinessId()).toBe(BUSINESS_A);

      runInTenantScope(businessScope(BUSINESS_B), () => {
        expect(getTenantBusinessId()).toBe(BUSINESS_B);
      });

      // Restoring on exit is what stops a nested per-business loop from
      // leaking the last iteration's tenant into the next.
      expect(getTenantBusinessId()).toBe(BUSINESS_A);
    });
  });

  it("survives await boundaries", async () => {
    await runInTenantScope(businessScope(BUSINESS_A), async () => {
      await Promise.resolve();
      expect(getTenantBusinessId()).toBe(BUSINESS_A);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(getTenantBusinessId()).toBe(BUSINESS_A);
    });
  });

  it("keeps concurrent scopes independent", async () => {
    const seen: string[] = [];
    const work = (id: string, delay: number) =>
      runInTenantScope(businessScope(id), async () => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        seen.push(getTenantBusinessId() ?? "none");
      });

    // Interleaved on purpose: two requests for different businesses in flight
    // at once must not observe each other's tenant.
    await Promise.all([work(BUSINESS_A, 5), work(BUSINESS_B, 1)]);
    expect(seen.sort()).toEqual([BUSINESS_A, BUSINESS_B].sort());
  });

  it("does not treat a bypass scope as a business", () => {
    runInTenantScope({ kind: "bypass", reason: "login" }, () => {
      expect(getTenantScope().kind).toBe("bypass");
      expect(getTenantBusinessId()).toBeNull();
    });
  });

  it("enterTenantScope applies to the rest of the current execution", async () => {
    await runInTenantScope(NO_SCOPE, async () => {
      expect(getTenantBusinessId()).toBeNull();
      // This is the mechanism getSession() relies on: a guard sets the scope
      // and returns, and the handler that called it is scoped from then on.
      enterTenantScope(businessScope(BUSINESS_A));
      expect(getTenantBusinessId()).toBe(BUSINESS_A);
      await Promise.resolve();
      expect(getTenantBusinessId()).toBe(BUSINESS_A);
    });
  });
});

describe("businessScope", () => {
  it("defaults location and user to null", () => {
    expect(businessScope(BUSINESS_A)).toEqual({
      kind: "business",
      businessId: BUSINESS_A,
      locationId: null,
      userId: null,
    });
  });

  it("carries the active branch and acting membership when given", () => {
    expect(businessScope(BUSINESS_A, "loc-1", "user-1")).toMatchObject({
      locationId: "loc-1",
      userId: "user-1",
    });
  });
});
