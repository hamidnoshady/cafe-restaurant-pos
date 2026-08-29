import { describe, expect, it } from "vitest";
import {
  formatPhoneDisplay,
  isMobilePhone,
  normalizePhone,
  phoneDigits,
  phoneE164,
  samePhone,
} from "./phone";

describe("normalizePhone", () => {
  it("collapses the four common Iranian mobile spellings into one canonical form", () => {
    // The phase's own exit criterion: these are one customer, and until they
    // are one string, segmentation and duplicate detection are both wrong.
    const forms = ["09121234567", "+989121234567", "00989121234567", "9121234567"];
    const canonical = forms.map((form) => phoneE164(form));
    expect(new Set(canonical).size).toBe(1);
    expect(canonical[0]).toBe("+989121234567");
  });

  it("accepts Persian and Arabic-Indic digits", () => {
    expect(phoneE164("۰۹۱۲۱۲۳۴۵۶۷")).toBe("+989121234567");
    expect(phoneE164("٠٩١٢١٢٣٤٥٦٧")).toBe("+989121234567");
  });

  it("ignores the separators people actually type", () => {
    expect(phoneE164("0912 123 4567")).toBe("+989121234567");
    expect(phoneE164("0912-123-4567")).toBe("+989121234567");
    expect(phoneE164("(0912) 123.4567")).toBe("+989121234567");
    expect(phoneE164("+98 912 123 4567")).toBe("+989121234567");
  });

  it("returns the national form for display", () => {
    expect(normalizePhone("+989121234567").national).toBe("09121234567");
    expect(formatPhoneDisplay("+989121234567")).toBe("0912 123 4567");
  });

  it("recognises landlines without calling them mobiles", () => {
    const tehran = normalizePhone("02112345678");
    expect(tehran.valid).toBe(true);
    expect(tehran.kind).toBe("landline");
    // The distinction is load-bearing: an SMS audience must not include a
    // landline just because someone ticked the consent box.
    expect(isMobilePhone("02112345678")).toBe(false);
    expect(isMobilePhone("09121234567")).toBe(true);
  });

  it("refuses to canonicalise something it does not recognise", () => {
    for (const junk of ["", "   ", "abc", "12", "1234567890123456789"]) {
      const result = normalizePhone(junk);
      expect(result.valid).toBe(false);
      expect(result.e164).toBeNull();
    }
  });

  it("keeps the digits of an unparsable value so it stays searchable", () => {
    expect(normalizePhone("call me on 12").digits).toBe("12");
    expect(phoneDigits("۰۹۱۲-۱۲۳")).toBe("0912123");
  });

  it("never treats two unparsable values as the same person", () => {
    // Junk matching junk would merge unrelated customers — the one outcome the
    // merge flow must never produce on its own.
    expect(samePhone("abc", "abc")).toBe(false);
    expect(samePhone(null, null)).toBe(false);
    expect(samePhone("", "")).toBe(false);
    expect(samePhone("09121234567", "+98 912 123 4567")).toBe(true);
    expect(samePhone("09121234567", "09121234568")).toBe(false);
  });

  it("strips the country code only when what remains is still a whole number", () => {
    // A Tehran landline reaches the same canonical form whether it was written
    // with the country code or the trunk zero…
    expect(phoneE164("+982112345678")).toBe("+982112345678");
    expect(phoneE164("02112345678")).toBe("+982112345678");
    expect(samePhone("+98 21 1234 5678", "021-1234-5678")).toBe(true);

    // …while a short string that merely *begins* with 98 is not quietly
    // truncated into a different number: it fails to parse instead.
    expect(normalizePhone("9821345").valid).toBe(false);
  });
});
