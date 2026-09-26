import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as aiConfig from "@/lib/ai-config";
import * as aiRuntime from "@/lib/ai-runtime";
import * as aiWalletBilling from "@/lib/ai-wallet-billing";
import * as invoiceOcrService from "@/lib/ai-invoice-ocr-service";
import * as setupState from "@/lib/setup-state";
import { POST } from "./route";

/**
 * Owner/manager-only metered supplier-invoice OCR: permission → attachment
 * validation → an active location → AI-config guard → wallet gate (before
 * the metered call) → the provider call → settle only on success. Unlike
 * `/api/ai/receipt-ocr`, the image is never persisted anywhere — this route
 * has its own documented design decision for that, so there is no
 * media-service interaction to assert here at all (its absence is itself
 * part of what these tests pin).
 */

vi.mock("@/lib/auth", () => ({
  withTenantScope: (handler: (...args: unknown[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, requireManager: vi.fn(), resolveActiveLocation: vi.fn() };
});

vi.mock("@/lib/ai-config", () => ({
  isPlatformAiConfigured: vi.fn(() => true),
  logAiRuntimeUnavailable: vi.fn(() => "not_ready"),
}));

vi.mock("@/lib/ai-runtime", () => ({
  resolveAiConfigFor: vi.fn(async () => ({ baseUrl: "http://gw/v1", apiKey: "sk-1", model: "gpt-4o-mini" })),
}));

vi.mock("@/lib/ai-wallet-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-wallet-billing")>();
  return { ...actual, gateAiTurn: vi.fn(), settleAiTurn: vi.fn(), newAiRequestId: () => "req-1" };
});

vi.mock("@/lib/ai-invoice-ocr-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-invoice-ocr-service")>();
  return { ...actual, runInvoiceOcr: vi.fn() };
});

const SESSION = { businessId: "biz-1", sub: "user-1", role: "owner" };
const LOCATION = { id: "loc-1" };

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

function req(body: unknown): NextRequest {
  return new Request("http://localhost:3000/api/ai/invoice-ocr", {
    method: "POST",
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  // vi.clearAllMocks() clears call history but not a prior mockReturnValue —
  // reset this one explicitly so an earlier test's override can't leak in.
  vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(true);
  vi.mocked(setupState.requireManager).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(LOCATION as never);
  vi.mocked(aiWalletBilling.gateAiTurn).mockResolvedValue(undefined as never);
  vi.mocked(aiWalletBilling.settleAiTurn).mockResolvedValue({ chargedRial: 4500 } as never);
  vi.mocked(invoiceOcrService.runInvoiceOcr).mockResolvedValue({
    extraction: { vendor: "بازرگانی رضایی", invoiceDate: "2026-01-10", invoiceNumber: "INV-1", totalRial: 500000, note: "x", lines: [], rawText: null },
    lines: [],
    validation: { verdict: "pass", summary: "ok", issues: [], overallConfidence: 0.9 },
    supplierId: "sup-1",
    supplierName: "بازرگانی رضایی",
    usage: { inputTokens: 900, outputTokens: 120 },
    costUsd: 0.004,
  } as never);
});

describe("POST /api/ai/invoice-ocr", () => {
  it("400s attachment_invalid for an unsupported format, before touching the wallet", async () => {
    const res = await POST(req({ image: "data:text/plain;base64,aGVsbG8=" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("attachment_invalid");
    expect(aiWalletBilling.gateAiTurn).not.toHaveBeenCalled();
  });

  it("accepts the legacy { dataUrl } wrapper shape as well as a bare string", async () => {
    const res = await POST(req({ dataUrl: PNG_DATA_URL }));
    expect(res.status).toBe(200);
  });

  it("409s no_location when the business has no active location resolved", async () => {
    vi.mocked(setupState.resolveActiveLocation).mockResolvedValue(null);
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_location");
    expect(aiWalletBilling.gateAiTurn).not.toHaveBeenCalled();
  });

  it("503s ai_unavailable when the platform AI runtime is not configured", async () => {
    vi.mocked(aiConfig.isPlatformAiConfigured).mockReturnValue(false);
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(503);
    expect(aiRuntime.resolveAiConfigFor).toHaveBeenCalled();
    expect(aiWalletBilling.gateAiTurn).not.toHaveBeenCalled();
  });

  it("402s ai_credit_required before the provider is ever called when the wallet cannot cover a turn", async () => {
    const { AiWalletInsufficientError } = await import("@/lib/ai-wallet-billing");
    vi.mocked(aiWalletBilling.gateAiTurn).mockRejectedValue(new AiWalletInsufficientError(0, 0, 1000));
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(402);
    expect(invoiceOcrService.runInvoiceOcr).not.toHaveBeenCalled();
  });

  it("on success: passes the resolved location's id, settles the wallet, and returns the full result — no media persistence call at all", async () => {
    const res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.extraction.vendor).toBe("بازرگانی رضایی");
    expect(json.supplierId).toBe("sup-1");
    expect(json.costRial).toBe(4500);
    expect(json).not.toHaveProperty("asset");

    expect(invoiceOcrService.runInvoiceOcr).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: LOCATION.id, dataUrl: PNG_DATA_URL }),
    );
    expect(aiWalletBilling.settleAiTurn).toHaveBeenCalledTimes(1);
  });

  it("maps InvoiceOcrError codes to their documented HTTP status and settles nothing", async () => {
    const { InvoiceOcrError } = await import("@/lib/ai-invoice-ocr-service");

    vi.mocked(invoiceOcrService.runInvoiceOcr).mockRejectedValue(new InvoiceOcrError("ai_auth", "کلید نامعتبر است."));
    let res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(502);

    vi.mocked(invoiceOcrService.runInvoiceOcr).mockRejectedValue(new InvoiceOcrError("ai_timeout", "زمان پایان یافت."));
    res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(504);

    vi.mocked(invoiceOcrService.runInvoiceOcr).mockRejectedValue(new InvoiceOcrError("ai_network", "قطع اتصال."));
    res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(504);

    vi.mocked(invoiceOcrService.runInvoiceOcr).mockRejectedValue(
      new InvoiceOcrError("extraction_failed", "استخراج ممکن نشد."),
    );
    res = await POST(req({ image: PNG_DATA_URL }));
    expect(res.status).toBe(422);

    expect(aiWalletBilling.settleAiTurn).not.toHaveBeenCalled();
  });

  it("400s on unparseable JSON before any guard runs", async () => {
    const badRequest = { json: () => Promise.reject(new Error("bad")) } as unknown as NextRequest;
    const res = await POST(badRequest);
    expect(res.status).toBe(400);
    expect(setupState.requireManager).toHaveBeenCalled();
  });
});
