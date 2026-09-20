import { describe, it, expect } from "vitest";
import { platformErrorText, isKnownPlatformError } from "./platform-errors";

describe("platform-errors", () => {
  it("translates known shared codes to Persian text", () => {
    expect(platformErrorText("unauthorized")).toBe("وارد نشده‌اید.");
    expect(platformErrorText("forbidden")).toContain("سطح دسترسی");
    expect(platformErrorText("not_found")).toBe("پیدا نشد.");
  });

  it("translates the client-synthesized transport codes", () => {
    expect(platformErrorText("network_error")).toContain("ارتباط");
    expect(platformErrorText("parse_error")).toContain("پاسخ سرور");
    expect(platformErrorText("request_cancelled")).toContain("لغو");
    expect(platformErrorText("server_error")).toContain("سرور");
  });

  it("never returns the raw code for an unknown error", () => {
    const out = platformErrorText("some_totally_unknown_code");
    expect(out).not.toContain("some_totally_unknown_code");
    expect(out).toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
  });

  it("prefers a caller-supplied domain-specific message", () => {
    expect(
      platformErrorText("domain_specific", { domain_specific: "پیام دامنه‌ای" }),
    ).toBe("پیام دامنه‌ای");
  });

  it("handles null/undefined without throwing", () => {
    expect(platformErrorText(null)).toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
    expect(platformErrorText(undefined)).toBe("خطای غیرمنتظره. دوباره تلاش کنید.");
  });

  it("isKnownPlatformError reflects the shared vocabulary only", () => {
    expect(isKnownPlatformError("unauthorized")).toBe(true);
    expect(isKnownPlatformError("nope")).toBe(false);
    expect(isKnownPlatformError(null)).toBe(false);
  });
});
