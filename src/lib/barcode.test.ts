import { describe, expect, it } from "vitest";
import {
  checkDigitFor,
  classifyBarcode,
  internalBarcodeForPayload,
  internalPayloadFromNumber,
  isValidEan13,
  isValidUpcA,
  normalizeBarcode,
} from "./barcode";

describe("normalizeBarcode", () => {
  it("folds Persian and Arabic-Indic digits to ASCII", () => {
    expect(normalizeBarcode(" ۶۲۶۰۱۲۳۴۵۶۷۸۹  ")).toBe("6260123456789");
    expect(normalizeBarcode("٦٢٦٠١٢٣٤٥٦٧٨٩")).toBe("6260123456789");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeBarcode("  123  ")).toBe("123");
  });
});

describe("checkDigitFor", () => {
  it("computes the EAN-13 check digit for a known code", () => {
    // EAN-13 4006381333931: payload 400638133393, check 1.
    expect(checkDigitFor("400638133393")).toBe("1");
  });

  it("computes the UPC-A check digit for a known code", () => {
    // UPC-A 036000291452: payload 03600029145, check 2.
    expect(checkDigitFor("03600029145")).toBe("2");
  });

  it("rejects non-digit payloads", () => {
    expect(() => checkDigitFor("40063813x393")).toThrow();
  });
});

describe("isValidEan13 / isValidUpcA", () => {
  it("accepts a valid EAN-13 and rejects a tampered one", () => {
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
  });

  it("accepts a valid UPC-A and rejects a tampered one", () => {
    expect(isValidUpcA("036000291452")).toBe(true);
    expect(isValidUpcA("036000291453")).toBe(false);
  });

  it("rejects wrong-length codes", () => {
    expect(isValidEan13("400638133393")).toBe(false);
    expect(isValidUpcA("03600029145")).toBe(false);
  });
});

describe("classifyBarcode", () => {
  it("classifies a supplier EAN-13", () => {
    expect(classifyBarcode("4006381333931")).toBe("EAN13");
  });

  it("classifies a supplier UPC-A", () => {
    expect(classifyBarcode("036000291452")).toBe("UPC");
  });

  it("classifies a valid internal-prefix code as internal", () => {
    const code = internalBarcodeForPayload("00000000001");
    expect(classifyBarcode(code)).toBe("internal");
  });

  it("returns null for malformed codes", () => {
    expect(classifyBarcode("hello")).toBeNull();
    expect(classifyBarcode("4006381333932")).toBeNull(); // bad check digit
    expect(classifyBarcode("12345")).toBeNull();
  });
});

describe("internalBarcodeForPayload / internalPayloadFromNumber", () => {
  it("mints a 13-digit code with the reserved prefix and a valid check digit", () => {
    const code = internalBarcodeForPayload("00000000001");
    expect(code).toHaveLength(13);
    expect(code.startsWith("2")).toBe(true);
    expect(isValidEan13(code)).toBe(true);
  });

  it("rejects a payload that is not 11 digits", () => {
    expect(() => internalBarcodeForPayload("123")).toThrow();
  });

  it("pads a number payload to 11 digits", () => {
    expect(internalPayloadFromNumber(1)).toBe("00000000001");
    expect(internalPayloadFromNumber(0)).toBe("00000000000");
  });

  it("folds negative and over-long inputs into the 11-digit window", () => {
    expect(internalPayloadFromNumber(-7)).toBe("00000000007");
    expect(internalPayloadFromNumber(100_000_000_000 + 5)).toBe("00000000005");
  });
});
