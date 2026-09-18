import { describe, expect, it } from "vitest";
import {
  barcodeEntryError,
  checkDigitFor,
  classifyBarcode,
  ean13Modules,
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

describe("barcodeEntryError", () => {
  it("refuses a 13-digit code with a broken check digit", () => {
    expect(barcodeEntryError("4006381333932")).toMatch(/رقم کنترل/);
  });

  it("refuses a 12-digit code with a broken check digit", () => {
    expect(barcodeEntryError("036000291453")).toMatch(/رقم کنترل/);
  });

  it("accepts valid EAN-13 and UPC-A codes", () => {
    expect(barcodeEntryError("4006381333931")).toBeNull();
    expect(barcodeEntryError("036000291452")).toBeNull();
  });

  it("passes through codes in other shapes (EAN-8, Code 128 text)", () => {
    // Not EAN-13/UPC-A shaped, so no check-digit claim can be made about them.
    expect(barcodeEntryError("12345670")).toBeNull();
    expect(barcodeEntryError("ABC-001")).toBeNull();
  });
});

describe("ean13Modules", () => {
  /** Decode the module string back to digits — the inverse of the encoder. */
  function decode(modules: string): string {
    const L = [
      "0001101", "0011001", "0010011", "0111101", "0100011",
      "0110001", "0101111", "0111011", "0110111", "0001011",
    ];
    const complement = (p: string) => [...p].map((c) => (c === "1" ? "0" : "1")).join("");
    const reverse = (p: string) => [...p].reverse().join("");
    const G = L.map((p) => reverse(complement(p)));
    const R = L.map(complement);
    const PARITIES = [
      "LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
      "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL",
    ];
    let pos = 3;
    const digits: number[] = [];
    let parity = "";
    for (let i = 0; i < 6; i++) {
      const seg = modules.slice(pos, pos + 7);
      pos += 7;
      const l = L.indexOf(seg);
      const g = G.indexOf(seg);
      if (l >= 0) {
        digits.push(l);
        parity += "L";
      } else if (g >= 0) {
        digits.push(g);
        parity += "G";
      } else {
        throw new Error(`unreadable left segment ${seg}`);
      }
    }
    pos += 5; // centre guard
    for (let i = 0; i < 6; i++) {
      const seg = modules.slice(pos, pos + 7);
      pos += 7;
      const r = R.indexOf(seg);
      if (r < 0) throw new Error(`unreadable right segment ${seg}`);
      digits.push(r);
    }
    return String(PARITIES.indexOf(parity)) + digits.join("");
  }

  it("is 95 modules with the three guards in place", () => {
    const modules = ean13Modules("4006381333931")!;
    expect(modules).toHaveLength(95);
    expect(modules.startsWith("101")).toBe(true);
    expect(modules.slice(45, 50)).toBe("01010");
    expect(modules.endsWith("101")).toBe(true);
  });

  it("round-trips a supplier EAN-13 through decode", () => {
    expect(decode(ean13Modules("4006381333931")!)).toBe("4006381333931");
  });

  it("round-trips a minted internal code through decode", () => {
    const code = internalBarcodeForPayload("12345678901");
    expect(decode(ean13Modules(code)!)).toBe(code);
  });

  it("renders a UPC-A as its 13-digit zero-prefixed form", () => {
    expect(decode(ean13Modules("036000291452")!)).toBe("0036000291452");
  });

  it("returns null for anything that is not EAN-13/UPC-A", () => {
    expect(ean13Modules("4006381333932")).toBeNull(); // bad check digit
    expect(ean13Modules("12345")).toBeNull();
    expect(ean13Modules("hello")).toBeNull();
  });
});
