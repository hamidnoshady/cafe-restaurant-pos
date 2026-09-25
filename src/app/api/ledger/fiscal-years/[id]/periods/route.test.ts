import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as fiscalService from "@/lib/fiscal-periods-service";
import { GET } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    // Tenant scope itself is covered by the integration suite. The route test
    // focuses on its HTTP contract.
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/fiscal-periods-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fiscal-periods-service")>();
  return { ...actual, listPeriods: vi.fn() };
});

const SESSION = { businessId: "business-1" };
const YEAR_ID = "00000000-0000-4000-8000-000000000001";
const CONTEXT = { params: Promise.resolve({ id: YEAR_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: SESSION, error: null } as never);
});

describe("GET /api/ledger/fiscal-years/[id]/periods", () => {
  it("returns the selected fiscal year's periods", async () => {
    const periods = [{ id: "period-1", status: "open" }];
    vi.mocked(fiscalService.listPeriods).mockResolvedValue(periods as never);

    const response = await GET({} as NextRequest, CONTEXT);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ periods });
    expect(fiscalService.listPeriods).toHaveBeenCalledWith(SESSION.businessId, YEAR_ID);
  });

  it("returns an accounting 404 when the URL references a missing or malformed year", async () => {
    vi.mocked(fiscalService.listPeriods).mockRejectedValue(
      new fiscalService.FiscalPeriodError("fiscal_year_not_found", 404),
    );

    const response = await GET({} as NextRequest, CONTEXT);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "fiscal_year_not_found" });
  });

  it("keeps the read role gate ahead of all service work", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);

    expect(await GET({} as NextRequest, CONTEXT)).toBe(denied);
    expect(fiscalService.listPeriods).not.toHaveBeenCalled();
  });
});
