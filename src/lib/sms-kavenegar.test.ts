import { describe, it, expect } from "vitest";
import {
  isOperatorFault,
  KavenegarError,
  kavenegarStatusMessage,
  redactKavenegarUrl,
} from "./sms-kavenegar";

describe("sms-kavenegar", () => {
  it("redacts API keys from Kavenegar URLs", () => {
    const raw = "https://api.kavenegar.com/v1/313233343536373839/verify/lookup.json?receptor=0912&token=1234&template=login";
    const redacted = redactKavenegarUrl(raw);
    expect(redacted).toBe("https://api.kavenegar.com/v1/REDACTED/verify/lookup.json?receptor=0912&token=REDACTED&template=login");
    expect(redacted).not.toContain("313233343536373839");
  });

  it("also redacts the OTP itself — a rejected/failed request otherwise puts the live code straight into server logs", () => {
    const raw = "https://api.kavenegar.com/v1/apikey/verify/lookup.json?receptor=0912&token=482913&template=login";
    const redacted = redactKavenegarUrl(raw);
    expect(redacted).not.toContain("482913");
  });
});

describe("Kavenegar status codes", () => {
  it("maps the codes an operator will actually hit to Persian", () => {
    // 411 invalid receptor, 418 out of credit, 424 template missing — the three
    // that account for most real failures.
    expect(kavenegarStatusMessage(411)).toContain("گیرنده");
    expect(kavenegarStatusMessage(418)).toContain("اعتبار");
    expect(kavenegarStatusMessage(424)).toContain("الگو");
  });

  it("never leaves an unknown code as raw carrier English", () => {
    const message = kavenegarStatusMessage(999);
    expect(message).toMatch(/[\u0600-\u06FF]/); // Persian text, not the carrier's English
    expect(message).toMatch(/999/); // the code itself is still diagnosable from a screenshot
    expect(message).not.toMatch(/[a-z]{4,}/); // no English words
  });

  it("distinguishes an operator's problem from the user's", () => {
    // Told "invalid receptor" a user retypes their number and it works. Told the
    // same when the real cause is an empty credit balance, they retype it
    // twenty times and phone support — so 418 is operator-fault and 411 is not.
    expect(isOperatorFault(411)).toBe(false);
    expect(isOperatorFault(418)).toBe(true);
    expect(isOperatorFault(403)).toBe(true);
    expect(isOperatorFault(424)).toBe(true);
  });

  it("carries the status on the error, and never the API key", () => {
    const err = new KavenegarError(418);
    expect(err.status).toBe(418);
    expect(err.operatorFault).toBe(true);
    expect(JSON.stringify({ message: err.message, name: err.name })).not.toContain("api.kavenegar.com");
  });
});
