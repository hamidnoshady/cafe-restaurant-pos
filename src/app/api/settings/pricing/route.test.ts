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

function request(body: unknown) {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(pricing.getPricingConfig).mockResolvedValue(EXISTING);
});

describe("pricing settings API", () => {
  it("returns the stored pricing policy", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pricing: EXISTING });
    expect(pricing.getPricingConfig).toHaveBeenCalledWith("biz-1");
  });

  it("accepts manual overhead mode and persists it", async () => {
    const response = await PUT(
      request({ defaultMarginPercent: 40, fallbackOverheadPercent: 22, overheadMode: "manual" }),
    );
    expect(response.status).toBe(200);
    expect(pricing.setPricingConfig).toHaveBeenCalledWith("biz-1", {
      defaultMarginPercent: 40,
      fallbackOverheadPercent: 22,
      overheadMode: "manual",
      costDriftThresholdPercent: 35,
    });
  });

  it("rejects an unknown overhead mode", async () => {
    const response = await PUT(request({ overheadMode: "sometimes" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_overhead_mode" });
    expect(pricing.setPricingConfig).not.toHaveBeenCalled();
  });

  it("does not reset newer settings when an older client omits them", async () => {
    const response = await PUT(request({ defaultMarginPercent: 32, fallbackOverheadPercent: 18 }));
    expect(response.status).toBe(200);
    expect(pricing.setPricingConfig).toHaveBeenCalledWith("biz-1", {
      defaultMarginPercent: 32,
      fallbackOverheadPercent: 18,
      overheadMode: "manual",
      costDriftThresholdPercent: 35,
    });
  });

  it("rejects an out-of-range drift threshold", async () => {
    const response = await PUT(request({ costDriftThresholdPercent: 1000 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_drift_threshold" });
  });
});
