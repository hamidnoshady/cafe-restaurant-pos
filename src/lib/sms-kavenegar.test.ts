import { describe, it, expect } from "vitest";
import { redactKavenegarUrl } from "./sms-kavenegar";

describe("sms-kavenegar", () => {
  it("redacts API keys from Kavenegar URLs", () => {
    const raw = "https://api.kavenegar.com/v1/313233343536373839/verify/lookup.json?receptor=0912&token=1234&template=login";
    const redacted = redactKavenegarUrl(raw);
    expect(redacted).toBe("https://api.kavenegar.com/v1/REDACTED/verify/lookup.json?receptor=0912&token=1234&template=login");
    expect(redacted).not.toContain("313233343536373839");
  });
});
