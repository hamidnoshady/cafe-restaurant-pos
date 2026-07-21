import { describe, expect, it } from "vitest";
import { isValidPrinterConnection, resolvedPaperWidthMm, resolvedPort } from "./printer-connection";

describe("isValidPrinterConnection", () => {
  it("requires a non-empty ip string", () => {
    expect(isValidPrinterConnection({ ip: "192.168.1.50" })).toBe(true);
    expect(isValidPrinterConnection({ ip: "" })).toBe(false);
    expect(isValidPrinterConnection({})).toBe(false);
    expect(isValidPrinterConnection(null)).toBe(false);
    expect(isValidPrinterConnection("192.168.1.50")).toBe(false);
  });

  it("rejects a non-numeric port", () => {
    expect(isValidPrinterConnection({ ip: "192.168.1.50", port: "9100" })).toBe(false);
    expect(isValidPrinterConnection({ ip: "192.168.1.50", port: 9100 })).toBe(true);
  });
});

describe("resolvedPort", () => {
  it("defaults to 9100", () => {
    expect(resolvedPort({ ip: "x" })).toBe(9100);
    expect(resolvedPort({ ip: "x", port: 0 })).toBe(9100);
    expect(resolvedPort({ ip: "x", port: 9200 })).toBe(9200);
  });
});

describe("resolvedPaperWidthMm", () => {
  it("defaults to 80mm", () => {
    expect(resolvedPaperWidthMm({ ip: "x" })).toBe(80);
    expect(resolvedPaperWidthMm({ ip: "x", paperWidthMm: 58 })).toBe(58);
    expect(resolvedPaperWidthMm({ ip: "x", paperWidthMm: 80 })).toBe(80);
  });
});
