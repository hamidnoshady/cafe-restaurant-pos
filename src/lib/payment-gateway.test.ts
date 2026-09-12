/**
 * Unit tests for the Zarinpal gateway adapter. The network boundary is mocked
 * with `fetch` stubs; nothing here touches the database or the real gateway.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayError,
  gatewayErrorMessage,
  zarinpalPaymentUrl,
  zarinpalRequest,
  zarinpalVerify,
  ZARINPAL_DEMO_MERCHANT,
  type PaymentGatewayConfig,
} from "./payment-gateway";

const liveConfig: PaymentGatewayConfig = {
  gateway: "zarinpal",
  merchantId: "abcd-1234",
  sandbox: false,
  callbackUrl: "https://app.example.com/settings/billing",
  currency: "IRR",
};
const sandboxConfig: PaymentGatewayConfig = { ...liveConfig, sandbox: true };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("zarinpalPaymentUrl", () => {
  it("points at the live host when sandbox is off", () => {
    expect(zarinpalPaymentUrl("AUTH", false)).toBe(
      "https://payment.zarinpal.com/pg/StartPay/AUTH",
    );
  });
  it("points at the sandbox host when sandbox is on", () => {
    expect(zarinpalPaymentUrl("AUTH", true)).toBe(
      "https://sandbox.zarinpal.com/pg/StartPay/AUTH",
    );
  });
});

describe("zarinpalRequest", () => {
  it("builds the callback with the payment id and returns the redirect URL", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: { authority: "AUTH-123", code: 100 } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await zarinpalRequest(liveConfig, {
      amountRial: 500_000,
      description: "شارژ",
      paymentId: "pay-1",
    });

    expect(result.authority).toBe("AUTH-123");
    expect(result.redirectUrl).toBe("https://payment.zarinpal.com/pg/StartPay/AUTH-123");
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://payment.zarinpal.com/pg/v4/payment/request.json");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      merchant_id: "abcd-1234",
      amount: 500_000,
      callback_url: "https://app.example.com/settings/billing?payment=pay-1",
      description: "شارژ",
    });
  });

  it("uses the sandbox base and demo merchant in sandbox mode when no merchant is set", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: { authority: "S", code: 100 } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const cfg = { ...sandboxConfig, merchantId: "" };
    await zarinpalRequest(cfg, { amountRial: 10_000, description: "x", paymentId: "p" });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://sandbox.zarinpal.com/pg/v4/payment/request.json");
    expect(JSON.parse(init.body as string).merchant_id).toBe(ZARINPAL_DEMO_MERCHANT);
  });

  it("throws callback_not_configured when no callback URL is set", async () => {
    await expect(
      zarinpalRequest({ ...liveConfig, callbackUrl: "" }, {
        amountRial: 1,
        description: "x",
        paymentId: "p",
      }),
    ).rejects.toMatchObject({ code: "callback_not_configured" });
  });

  it("throws gateway_request_failed when the gateway refuses (code -11)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { code: -11 }, errors: { message: "bad" } })),
    );
    await expect(
      zarinpalRequest(liveConfig, { amountRial: 1, description: "x", paymentId: "p" }),
    ).rejects.toBeInstanceOf(GatewayError);
  });

  it("throws gateway_request_failed when no authority is returned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: {} })));
    await expect(
      zarinpalRequest(liveConfig, { amountRial: 1, description: "x", paymentId: "p" }),
    ).rejects.toMatchObject({ code: "gateway_request_failed" });
  });
});

describe("zarinpalVerify", () => {
  it("reports verified with the RefID on code 100", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { code: 100, ref_id: 987654321 } })),
    );
    const r = await zarinpalVerify(liveConfig, { amountRial: 500_000, authority: "AUTH" });
    expect(r.verified).toBe(true);
    expect(r.refId).toBe("987654321");
    expect(r.alreadyVerified).toBeFalsy();
  });

  it("treats code 101 as already verified (still settled)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { code: 101, ref_id: 42 } })),
    );
    const r = await zarinpalVerify(liveConfig, { amountRial: 500_000, authority: "AUTH" });
    expect(r.verified).toBe(true);
    expect(r.alreadyVerified).toBe(true);
    expect(r.refId).toBe("42");
  });

  it("reports not verified (no throw) on a normal refusal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { code: -54 }, errors: { message: "nope" } })),
    );
    const r = await zarinpalVerify(liveConfig, { amountRial: 500_000, authority: "AUTH" });
    expect(r.verified).toBe(false);
  });

  it("throws gateway_unreachable on a 5xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ data: {} }, 503)));
    await expect(
      zarinpalVerify(liveConfig, { amountRial: 500_000, authority: "AUTH" }),
    ).rejects.toMatchObject({ code: "gateway_unreachable" });
  });

  it("sends merchant id, amount and authority to the verify endpoint", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: { code: 100, ref_id: 1 } }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    await zarinpalVerify(liveConfig, { amountRial: 123_456, authority: "AUTH-XYZ" });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://payment.zarinpal.com/pg/v4/payment/verify.json");
    expect(JSON.parse(init.body as string)).toMatchObject({
      merchant_id: "abcd-1234",
      amount: 123_456,
      authority: "AUTH-XYZ",
    });
  });
});

describe("gatewayErrorMessage", () => {
  it("maps known codes to Persian messages", () => {
    expect(gatewayErrorMessage("callback_not_configured")).toContain("بازگشت");
    expect(gatewayErrorMessage("payment_not_found")).toContain("پیدا نشد");
  });
  it("falls back for unknown codes", () => {
    expect(gatewayErrorMessage("something_else")).toContain("خطای درگاه");
  });
});
