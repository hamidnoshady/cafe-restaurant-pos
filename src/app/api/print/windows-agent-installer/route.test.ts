import { describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(async () => ({ session: { businessId: "biz-1" }, error: null })),
    withTenantScope: (
      handler: (request: NextRequest) => Promise<NextResponse>,
    ) => handler,
  };
});

import * as auth from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { GET } from "./route";

describe("GET /api/print/windows-agent-installer", () => {
  it("downloads a private installer pinned to the browser-facing tenant origin", async () => {
    const request = new NextRequest("http://internal:3000/api/print/windows-agent-installer", {
      headers: {
        host: "internal:3000",
        "x-forwarded-host": "rose.example.com",
        "x-forwarded-proto": "https",
      },
    });

    const response = await GET(request);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(auth.requirePermission).toHaveBeenCalledWith(PERMISSIONS.settingsManage);
    expect(response.headers.get("content-disposition")).toContain("Install-Cafe-POS-Print-Connector.cmd");
    expect(response.headers.get("cache-control")).toContain("no-store");
    // Forwarded host is ignored unless the deployment explicitly trusts it;
    // the same host policy used by tenant routing decides the allowed origin.
    expect(body).toContain("$origin = 'https://internal:3000'");
    expect(body).toContain("https://internal:3000/windows/cafe-pos-print-agent.ps1");
  });

  it("fails closed when no request host is available", async () => {
    const request = new NextRequest("https://example.com/api/print/windows-agent-installer");
    const response = await GET(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "installer_origin_unavailable" });
  });
});
