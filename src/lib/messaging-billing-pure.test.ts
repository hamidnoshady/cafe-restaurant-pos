import { describe, expect, it } from "vitest";
import {
  messageCostRial,
  smsSegmentCount,
  SMS_FIRST_SEGMENT_CHARS,
  SMS_NEXT_SEGMENT_CHARS,
} from "./messaging-billing-pure";

const rate = { smsRialPerSegment: 1000, emailRialPerSend: 500 };

describe("smsSegmentCount", () => {
  it("is one segment at or under the 70-char boundary", () => {
    expect(smsSegmentCount("")).toBe(1);
    expect(smsSegmentCount("a".repeat(SMS_FIRST_SEGMENT_CHARS))).toBe(1);
  });

  it("crosses to two at char 71", () => {
    expect(smsSegmentCount("a".repeat(SMS_FIRST_SEGMENT_CHARS + 1))).toBe(2);
  });

  it("stays two until the 2-segment capacity (70+67=137)", () => {
    expect(smsSegmentCount("a".repeat(SMS_FIRST_SEGMENT_CHARS + SMS_NEXT_SEGMENT_CHARS))).toBe(2);
  });

  it("crosses to three past 137", () => {
    expect(
      smsSegmentCount("a".repeat(SMS_FIRST_SEGMENT_CHARS + SMS_NEXT_SEGMENT_CHARS + 1)),
    ).toBe(3);
  });

  it("counts Persian text in UTF-16 code units", () => {
    // 71 Persian characters → two segments, like any other 71 characters.
    expect(smsSegmentCount("م".repeat(SMS_FIRST_SEGMENT_CHARS + 1))).toBe(2);
  });
});

describe("messageCostRial", () => {
  it("multiplies segments by the per-segment rate for sms", () => {
    expect(messageCostRial("sms", "a".repeat(71), rate)).toBe(2000);
    expect(messageCostRial("sms", "a".repeat(70), rate)).toBe(1000);
  });

  it("charges email flat regardless of length", () => {
    expect(messageCostRial("email", "x", rate)).toBe(500);
    expect(messageCostRial("email", "x".repeat(5_000), rate)).toBe(500);
  });

  it("keeps money an integer for a 71-char Persian message (never silently double-costs)", () => {
    // The regression this module exists for: a 71-char message must cost two
    // segments (2000 Rial at 1000/segment), not one.
    expect(messageCostRial("sms", "م".repeat(71), rate)).toBe(2000);
  });
});
