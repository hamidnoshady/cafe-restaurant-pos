/**
 * POST /api/printing/test-draft — the add-printer wizard's test print for a
 * printer that is not saved yet. Settings-managing roles only; the chosen
 * paper width is validated (58/80) and no hardware address is accepted —
 * rendering never needs one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as renderService from "@/lib/printing/render-service";
import { POST } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requirePermission: vi.fn(),
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});

vi.mock("@/lib/printing/render-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/printing/render-service")>();
  return { ...actual, buildDraftTestBytes: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth.requirePermission).mockResolvedValue({ session: { businessId: "biz-1" }, error: null } as never);
  vi.mocked(renderService.buildDraftTestBytes).mockResolvedValue(Buffer.from([0x1b, 0x40]) as never);
});

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

describe("POST /api/printing/test-draft", () => {
  it("requires the settings-manage permission", async () => {
    await POST(request({ kind: "receipt", paperWidthMm: 80 }));
    expect(auth.requirePermission).toHaveBeenCalledWith("settings.manage");
  });

  it("returns the permission gate's error untouched", async () => {
    const denied = NextResponse.json({ error: "forbidden" }, { status: 403 });
    vi.mocked(auth.requirePermission).mockResolvedValue({ session: null, error: denied } as never);
    expect((await POST(request({ kind: "receipt", paperWidthMm: 80 }))).status).toBe(403);
  });

  it("renders the sample for the chosen kind and roll width", async () => {
    const response = await POST(request({ kind: "kitchen", paperWidthMm: 58 }));
    expect(response.status).toBe(200);
    expect(renderService.buildDraftTestBytes).toHaveBeenCalledWith("kitchen", 58);
    const body = (await response.json()) as { ok: boolean; dataBase64: string };
    expect(body.ok).toBe(true);
    expect(body.dataBase64).toBe(Buffer.from([0x1b, 0x40]).toString("base64"));
  });

  it("rejects an unknown kind or an out-of-range width with 400", async () => {
    for (const body of [{}, { kind: "label", paperWidthMm: 80 }, { kind: "receipt", paperWidthMm: 62 }, { kind: "receipt", paperWidthMm: 0 }]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "bad_request" });
    }
    expect(renderService.buildDraftTestBytes).not.toHaveBeenCalled();
  });

  it("ignores any hardware address in the body — rendering takes none", async () => {
    const response = await POST(request({ kind: "receipt", paperWidthMm: 80, ip: "203.0.113.7", target: { type: "network", ip: "198.51.100.9" } }));
    expect(response.status).toBe(200);
    expect(renderService.buildDraftTestBytes).toHaveBeenCalledWith("receipt", 80);
  });

  it("maps a render failure to 502 render_failed", async () => {
    vi.mocked(renderService.buildDraftTestBytes).mockRejectedValue(new Error("chromium gone") as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(request({ kind: "receipt", paperWidthMm: 80 }));
    errorSpy.mockRestore();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "render_failed" });
  });
});
