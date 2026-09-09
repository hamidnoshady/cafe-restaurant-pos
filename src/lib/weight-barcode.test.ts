import { describe, expect, it } from "vitest";
import {
  buildWeightBarcode,
  ean13CheckDigit,
  formatBarcodeHumanReadable,
  generateItemBarcode,
  isValidEan13,
  sampleWeightBarcode,
  validateBarcodePrefix,
} from "./weight-barcode";

describe("ean13CheckDigit", () => {
  it("matches known retail codes", () => {
    expect(ean13CheckDigit("400638133393")).toBe("1");
    expect(ean13CheckDigit("590123412345")).toBe("7");
  });

  it("round-trips through isValidEan13", () => {
    const code = "201111101250" + ean13CheckDigit("201111101250");
    expect(isValidEan13(code)).toBe(true);
    expect(isValidEan13(code.slice(0, 12) + "9")).toBe(code[12] === "9");
  });
});

describe("buildWeightBarcode", () => {
  it("lays out prefix, item reference and weight, then the check digit", () => {
    const code = buildWeightBarcode({ prefix: "20", itemRef: 11111, weight: 1250, unit: "grams" });
    expect(code).toMatch(/^20\d{11}$/);
    expect(code.slice(2, 7)).toBe("11111");
    expect(code.slice(7, 12)).toBe("01250");
    expect(isValidEan13(code)).toBe(true);
  });

  it("zero-pads short references and caps weight at five digits", () => {
    const code = buildWeightBarcode({ prefix: "21", itemRef: 7, weight: 123456, unit: "grams" });
    expect(code.slice(2, 7)).toBe("00007");
    expect(code.slice(7, 12)).toBe("23456");
  });
});

describe("template validation and samples", () => {
  it("accepts two-digit prefixes only", () => {
    expect(validateBarcodePrefix("20")).toBeNull();
    expect(validateBarcodePrefix("2")).not.toBeNull();
    expect(validateBarcodePrefix("۲۰")).not.toBeNull();
    expect(validateBarcodePrefix("200")).not.toBeNull();
  });

  it("samples are valid, stable codes for the preview", () => {
    const sample = sampleWeightBarcode("22", "kilograms");
    expect(sample).toMatch(/^22/);
    expect(isValidEan13(sample)).toBe(true);
    expect(sampleWeightBarcode("22", "kilograms")).toBe(sample);
  });

  it("generated item barcodes carry the template prefix and pass check digit", () => {
    const code = generateItemBarcode("23", 12345);
    expect(code).toMatch(/^23\d{11}$/);
    expect(isValidEan13(code)).toBe(true);
  });

  it("groups the human-readable form like a label", () => {
    expect(formatBarcodeHumanReadable("2011111012507")).toBe("20 11111 01250 7");
  });
});
