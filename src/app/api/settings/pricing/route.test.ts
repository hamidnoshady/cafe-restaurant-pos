import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as pricing from "@/lib/pricing-service";
import { GET, PUT } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/pricing-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pricing-service")>();
  return {
    ...actual,
    getEffectiveOverheadRate: vi.fn(),
    getPricingConfig: vi.fn(),
    setPricingConfig: vi.fn(),
  };
});

const SESSION = { businessId: "biz-1" };
const EXISTING = {
  defaultMarginPercent: 30,
  fallbackOverheadPercent: 25,
  overheadMode: "manual" as const,
  costDriftThresholdPercent: 35,
};
const EFFECTIVE_OVERHEAD = {
  ratePercent: 25,
  source: "fallback" as const,
  ledgerRatePercent: 40,
  lookbackDays: 30,
};

function request(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(pricing.getPricingConfig).mockResolvedValue(EXISTING);
  vi.mocked(pricing.getEffectiveOverheadRate).mockResolvedValue(EFFECTIVE_OVERHEAD);
});

describe("pricing settings API", () => {
  it("returns the stored pricing policy and explains the effective overhead", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pricing: EXISTING,
      effectiveOverhead: EFFECTIVE_OVERHEAD,
    });
    expect(pricing.getPricingConfig).toHaveBeenCalledWith("biz-1");
    expect(pricing.getEffectiveOverheadRate).toHaveBeenCalledWith("biz-1", EXISTING);
  });

  it("keeps the saved policy available when the explanatory ledger summary fails", async () => {
    vi.mocked(pricing.getEffectiveOverheadRate).mockRejectedValueOnce(new Error("ledger unavailable"));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pricing: EXISTING, effectiveOverhead: null });
  });

  it("accepts manual overhead mode and persists every pricing field", async () => {
    const response = await PUT(
      request({
        defaultMarginPercent: 40,
        fallbackOverheadPercent: 22,
        overheadMode: "manual",
        costDriftThresholdPercent: 18,
      }),
    );
    expect(response.status).toBe(200);
    expect(pricing.setPricingConfig).toHaveBeenCalledWith("biz-1", {
      defaultMarginPercent: 40,
      fallbackOverheadPercent: 22,
      overheadMode: "manual",
      costDriftThresholdPercent: 18,
    });
    expect(await response.json()).toEqual({
      ok: true,
      pricing: {
        defaultMarginPercent: 40,
        fallbackOverheadPercent: 22,
        overheadMode: "manual",
        costDriftThresholdPercent: 18,
      },
      effectiveOverhead: EFFECTIVE_OVERHEAD,
    });
  });

  it("rejects an unknown overhead mode", async () => {
    const response = await PUT(request({ overheadMode: "sometimes" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_overhead_mode" });
    expect(pricing.setPricingConfig).not.toHaveBeenCalled();
  });

  it("requires a value when fixed manual overhead is selected", async () => {
    const response = await PUT(
      request({ overheadMode: "manual", fallbackOverheadPercent: null }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "manual_overhead_required" });
    expect(pricing.setPricingConfig).not.toHaveBeenCalled();
  });

  it("does not reset any setting when a partial/older client omits it", async () => {
    const response = await PUT(request({ defaultMarginPercent: 32 }));
    expect(response.status).toBe(200);
    expect(pricing.setPricingConfig).toHaveBeenCalledWith("biz-1", {
      defaultMarginPercent: 32,
      fallbackOverheadPercent: 25,
      overheadMode: "manual",
      costDriftThresholdPercent: 35,
    });
  });

  it("allows the optional margin and automatic fallback to be explicitly cleared", async () => {
    const response = await PUT(
      request({ defaultMarginPercent: null, fallbackOverheadPercent: null, overheadMode: "automatic" }),
    );
    expect(response.status).toBe(200);
    expect(pricing.setPricingConfig).toHaveBeenCalledWith("biz-1", {
      defaultMarginPercent: null,
      fallbackOverheadPercent: null,
      overheadMode: "automatic",
      costDriftThresholdPercent: 35,
    });
  });

  it("rejects zero and out-of-range drift thresholds", async () => {
    for (const value of [0, 1000]) {
      const response = await PUT(request({ costDriftThresholdPercent: value }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_drift_threshold" });
    }
    expect(pricing.setPricingConfig).not.toHaveBeenCalled();
  });

  it("does not coerce booleans, blank strings, arrays or objects into percentages", async () => {
    for (const invalid of [false, "", [], {}]) {
      const response = await PUT(request({ defaultMarginPercent: invalid }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_margin" });
    }
    expect(pricing.setPricingConfig).not.toHaveBeenCalled();
  });

  it("rejects null, arrays, and malformed JSON bodies without throwing", async () => {
    for (const body of [null, []]) {
      const response = await PUT(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
    }

    const malformed = {
      json: async () => {
        throw new SyntaxError("bad json");
      },
    } as unknown as NextRequest;
    const response = await PUT(malformed);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(pricing.setPricingConfig).not.toHaveBeenCalled();
  });
});
