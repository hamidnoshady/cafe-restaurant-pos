import { describe, expect, it } from "vitest";
import {
  describeConnection,
  isValidPrinterConnection,
  resolvedDriverMode,
  resolvedPaperWidthMm,
  resolvedPort,
  resolvedTransport,
} from "./printer-connection";

describe("isValidPrinterConnection", () => {
  it("requires a non-empty ip string on the network transport", () => {
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

describe("transports", () => {
  it("treats a row written before transports existed as a network printer", () => {
    expect(resolvedTransport({ ip: "192.168.1.50" })).toBe("network");
    expect(resolvedTransport({ transport: "nonsense" as never })).toBe("network");
  });

  it("validates each transport against the field it actually needs", () => {
    expect(isValidPrinterConnection({ transport: "system", systemName: "EPSON TM-T20" })).toBe(true);
    expect(isValidPrinterConnection({ transport: "system", systemName: "" })).toBe(false);
    // A system printer needs no IP, and a network one needs no queue name.
    expect(isValidPrinterConnection({ transport: "system", systemName: "Q", ip: null })).toBe(true);

    expect(isValidPrinterConnection({ transport: "usb", devicePath: "USB001" })).toBe(true);
    expect(isValidPrinterConnection({ transport: "usb" })).toBe(false);

    // webusb pairs by USB ids — the vendor id is the one hard requirement.
    expect(isValidPrinterConnection({ transport: "webusb", usbVendorId: 0x04b8 })).toBe(true);
    expect(isValidPrinterConnection({ transport: "webusb" })).toBe(false);
    expect(isValidPrinterConnection({ transport: "webusb", usbVendorId: 0 })).toBe(false);
  });

  it("accepts the browser transport with nothing configured — that is the point of it", () => {
    expect(isValidPrinterConnection({ transport: "browser" })).toBe(true);
  });

  it("defaults to the ESC/POS raster driver, not the page spooler", () => {
    expect(resolvedDriverMode({ ip: "x" })).toBe("raster");
    expect(resolvedDriverMode({ ip: "x", driverMode: "document" })).toBe("document");
  });

  it("describes where each kind of printer is, for the hardware list", () => {
    expect(describeConnection({ ip: "192.168.1.50", port: 9100 })).toBe("192.168.1.50:9100");
    expect(describeConnection({ transport: "system", systemName: "TM-T20" })).toBe("TM-T20");
    expect(describeConnection({ transport: "usb", devicePath: "/dev/usb/lp0" })).toBe("/dev/usb/lp0");
    expect(describeConnection({ transport: "webusb", usbProductName: "TM-T20III" })).toBe("TM-T20III");
    expect(describeConnection({ transport: "webusb", usbVendorId: 0x04b8, usbProductId: 0x0e15 })).toBe("USB 04b8:0e15");
    expect(describeConnection({ transport: "browser" })).toContain("مرورگر");
  });
});
