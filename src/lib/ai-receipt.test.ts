import { describe, expect, it } from "vitest";
import {
  MAX_RECEIPT_IMAGE_BYTES,
  parseReceiptExtractionReply,
  parseReceiptImageDataUrl,
} from "./ai-receipt";

const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("parseReceiptImageDataUrl", () => {
  it("accepts a well-formed jpeg/png/webp data URL", () => {
    expect(parseReceiptImageDataUrl(`data:image/png;base64,${SMALL_PNG_BASE64}`)).toEqual({
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${SMALL_PNG_BASE64}`,
    });
  });

  it("rejects a non-string, malformed, or unsupported-type value", () => {
    expect(parseReceiptImageDataUrl(undefined)).toBeNull();
    expect(parseReceiptImageDataUrl(42)).toBeNull();
    expect(parseReceiptImageDataUrl("not a data url")).toBeNull();
    expect(parseReceiptImageDataUrl(`data:image/gif;base64,${SMALL_PNG_BASE64}`)).toBeNull();
    expect(parseReceiptImageDataUrl("data:image/png;base64,")).toBeNull();
  });

  it("rejects a base64 payload over the size ceiling", () => {
    const huge = "A".repeat(Math.ceil((MAX_RECEIPT_IMAGE_BYTES * 4) / 3) + 2048);
    expect(parseReceiptImageDataUrl(`data:image/jpeg;base64,${huge}`)).toBeNull();
  });
});

describe("parseReceiptExtractionReply", () => {
  it("parses a well-formed JSON reply", () => {
    const reply = JSON.stringify({
      vendor: "سوپرمارکت رضا",
      expenseDate: "2026-07-15",
      amount: 450000,
      memo: "خرید مواد اولیه",
      suggestedAccountCode: "5100",
    });
    expect(parseReceiptExtractionReply(reply)).toEqual({
      vendor: "سوپرمارکت رضا",
      expenseDate: "2026-07-15",
      amount: 450000,
      memo: "خرید مواد اولیه",
      suggestedAccountCode: "5100",
    });
  });

  it("strips a ```json code fence some models add anyway", () => {
    const reply = "```json\n" + JSON.stringify({ vendor: "الف", amount: 1000, memo: "م" }) + "\n```";
    const parsed = parseReceiptExtractionReply(reply);
    expect(parsed?.vendor).toBe("الف");
    expect(parsed?.amount).toBe(1000);
  });

  it("falls back to defaults/null for missing or invalid fields, never faking a number", () => {
    const reply = JSON.stringify({ amount: "not-a-number", suggestedAccountCode: "9999" });
    expect(parseReceiptExtractionReply(reply)).toEqual({
      vendor: null,
      expenseDate: null,
      amount: null,
      memo: "هزینهٔ استخراج‌شده از تصویر پیوست — پیش از تأیید بررسی شود",
      suggestedAccountCode: null,
    });
  });

  it("returns null for unparseable or non-object replies", () => {
    expect(parseReceiptExtractionReply("این یک متن معمولی است، نه JSON")).toBeNull();
    expect(parseReceiptExtractionReply("42")).toBeNull();
    expect(parseReceiptExtractionReply("")).toBeNull();
  });

  it("rejects a negative or zero amount and a malformed date", () => {
    const reply = JSON.stringify({ amount: -500, expenseDate: "not-a-date" });
    const parsed = parseReceiptExtractionReply(reply);
    expect(parsed?.amount).toBeNull();
    expect(parsed?.expenseDate).toBeNull();
  });
});
