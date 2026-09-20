/**
 * types.ts — the canonical printer model and the legacy normalisation. What
 * must never regress:
 *
 *  - a saved printer is reached through exactly `windows` or `network`;
 *  - the old five-transport rows map cleanly where possible (`system` →
 *    windows, `network`/ip-only → network) and are flagged `needsReconnect`
 *    with their identity preserved everywhere else — never silently guessed;
 *  - a pre-transport stub with no address is reconnect-required, not a
 *    phantom network printer;
 *  - validation demands the one field each type actually needs.
 */
import { describe, expect, it } from "vitest";
import {
  describeConnection,
  isValidIpv4,
  isValidPrinterConnection,
  legacyTransportLabel,
  normalizeStoredConnection,
  printerTargetOf,
  resolvedPaperWidthMm,
  resolvedPort,
} from "./types";

describe("normalizeStoredConnection — canonical rows pass through", () => {
  it("keeps a windows row with its queue name", () => {
    const normalized = normalizeStoredConnection({ type: "windows", systemName: "EPSON TM-T20III", paperWidthMm: 80 });
    expect(normalized.type).toBe("windows");
    expect(normalized.systemName).toBe("EPSON TM-T20III");
    expect(normalized.needsReconnect).toBeUndefined();
  });

  it("keeps a network row and defaults an absent port to 9100 via resolvedPort", () => {
    const normalized = normalizeStoredConnection({ type: "network", ip: "192.168.1.45" });
    expect(normalized.type).toBe("network");
    expect(normalized.ip).toBe("192.168.1.45");
    expect(resolvedPort(normalized)).toBe(9100);
  });
});

describe("normalizeStoredConnection — legacy rows", () => {
  it("maps a legacy `system` row to windows", () => {
    const normalized = normalizeStoredConnection({
      transport: "system",
      systemName: "POS-80",
      ip: null,
      port: 9100,
      openDrawer: true,
      isDefault: true,
    });
    expect(normalized.type).toBe("windows");
    expect(normalized.systemName).toBe("POS-80");
    expect(normalized.openDrawer).toBe(true);
    expect(normalized.isDefault).toBe(true);
    expect(normalized.needsReconnect).toBeUndefined();
  });

  it("maps a legacy `network` row (and a pre-transport row with an ip) to network", () => {
    expect(normalizeStoredConnection({ transport: "network", ip: "10.0.0.9", port: 9101 }).type).toBe("network");
    const preTransport = normalizeStoredConnection({ ip: "10.0.0.9", port: 9100, paperWidthMm: 58 });
    expect(preTransport.type).toBe("network");
    expect(preTransport.paperWidthMm).toBe(58);
  });

  it("flags usb / webusb / browser rows as needing reconnection, with identity preserved", () => {
    const usb = normalizeStoredConnection({ transport: "usb", devicePath: "USB001", name: "x" });
    expect(usb.needsReconnect).toBe(true);
    expect(usb.legacyTransport).toBe("usb");
    expect(usb.devicePath).toBe("USB001");

    const webusb = normalizeStoredConnection({ transport: "webusb", usbVendorId: 0x04b8, usbProductName: "TM-T20III" });
    expect(webusb.needsReconnect).toBe(true);
    expect(webusb.legacyTransport).toBe("webusb");
    expect(webusb.usbProductName).toBe("TM-T20III");

    const browser = normalizeStoredConnection({ transport: "browser" });
    expect(browser.needsReconnect).toBe(true);
    expect(browser.legacyTransport).toBe("browser");
  });

  it("flags a pre-transport stub with no address (the old wizard's rows) as reconnect-required, not network", () => {
    const stub = normalizeStoredConnection({ ip: null, port: 9100, driver: "escpos-stub" });
    expect(stub.needsReconnect).toBe(true);
    expect(stub.legacyTransport).toBe("unknown");
  });

  it("is total: garbage input still yields a reconnect-required row, never a throw", () => {
    expect(normalizeStoredConnection(null).needsReconnect).toBe(true);
    expect(normalizeStoredConnection("nope").needsReconnect).toBe(true);
    expect(normalizeStoredConnection([1, 2]).needsReconnect).toBe(true);
  });
});

describe("isValidPrinterConnection", () => {
  it("requires the queue name on windows", () => {
    expect(isValidPrinterConnection({ type: "windows", systemName: "EPSON" })).toBe(true);
    expect(isValidPrinterConnection({ type: "windows", systemName: "  " })).toBe(false);
    expect(isValidPrinterConnection({ type: "windows" })).toBe(false);
  });

  it("requires a strict IPv4 and a sane port on network", () => {
    expect(isValidPrinterConnection({ type: "network", ip: "192.168.1.45" })).toBe(true);
    expect(isValidPrinterConnection({ type: "network", ip: "192.168.1.45", port: 9100 })).toBe(true);
    expect(isValidPrinterConnection({ type: "network", ip: "printer.lan" })).toBe(false);
    expect(isValidPrinterConnection({ type: "network", ip: "999.1.1.1" })).toBe(false);
    expect(isValidPrinterConnection({ type: "network", ip: "192.168.1.45", port: 0 })).toBe(false);
    expect(isValidPrinterConnection({ type: "network", ip: "192.168.1.45", port: 70000 })).toBe(false);
  });

  it("refuses every legacy transport spelling", () => {
    expect(isValidPrinterConnection({ transport: "system", systemName: "EPSON" } as never)).toBe(false);
    expect(isValidPrinterConnection({ transport: "network", ip: "10.0.0.1" } as never)).toBe(false);
    expect(isValidPrinterConnection({ type: "usb", devicePath: "USB001" } as never)).toBe(false);
    expect(isValidPrinterConnection({ type: "webusb" } as never)).toBe(false);
    expect(isValidPrinterConnection({ type: "browser" } as never)).toBe(false);
  });
});

describe("printerTargetOf", () => {
  it("resolves the wire target for a usable printer", () => {
    expect(printerTargetOf({ type: "windows", systemName: "EPSON" })).toEqual({ type: "windows", systemName: "EPSON" });
    expect(printerTargetOf({ type: "network", ip: "192.168.1.45", port: 9101 })).toEqual({
      type: "network",
      ip: "192.168.1.45",
      port: 9101,
    });
    expect(printerTargetOf({ type: "network", ip: "192.168.1.45" })).toEqual({ type: "network", ip: "192.168.1.45", port: 9100 });
  });

  it("resolves legacy rows through the same normalisation", () => {
    expect(printerTargetOf({ transport: "system", systemName: "POS-80" })).toEqual({ type: "windows", systemName: "POS-80" });
  });

  it("yields null for reconnect-required rows", () => {
    expect(printerTargetOf({ transport: "webusb", usbVendorId: 0x04b8 })).toBeNull();
    expect(printerTargetOf({ needsReconnect: true, legacyTransport: "usb" })).toBeNull();
  });
});

describe("resolvedPaperWidthMm", () => {
  it("defaults to 80mm and honours both the explicit width and the paper key", () => {
    expect(resolvedPaperWidthMm({})).toBe(80);
    expect(resolvedPaperWidthMm({ paperWidthMm: 58 })).toBe(58);
    expect(resolvedPaperWidthMm({ paper: "thermal58" })).toBe(58);
    expect(resolvedPaperWidthMm({ paper: "thermal80" })).toBe(80);
  });
});

describe("describeConnection / legacyTransportLabel", () => {
  it("describes where each printer is, for the settings cards", () => {
    expect(describeConnection({ type: "windows", systemName: "TM-T20" })).toBe("TM-T20");
    expect(describeConnection({ type: "network", ip: "192.168.1.50", port: 9100 })).toBe("192.168.1.50");
    expect(describeConnection({ transport: "webusb", usbProductName: "TM-T20III" })).toBe("TM-T20III");
    expect(describeConnection({ transport: "usb", devicePath: "USB001" })).toBe("USB001");
  });

  it("labels a legacy transport in operator words", () => {
    expect(legacyTransportLabel("usb")).toContain("USB");
    expect(legacyTransportLabel("webusb")).toContain("مرورگر");
    expect(legacyTransportLabel("browser")).toContain("مرورگر");
    expect(legacyTransportLabel("unknown")).toContain("نامشخص");
  });
});

describe("isValidIpv4", () => {
  it("accepts real addresses and rejects the shapes that are not one", () => {
    expect(isValidIpv4("192.168.1.45")).toBe(true);
    expect(isValidIpv4("0.0.0.0")).toBe(true);
    expect(isValidIpv4("255.255.255.255")).toBe(true);
    expect(isValidIpv4("256.1.1.1")).toBe(false);
    expect(isValidIpv4("192.168.1")).toBe(false);
    expect(isValidIpv4("192.168.1.1.1")).toBe(false);
    expect(isValidIpv4("192.168.1.x")).toBe(false);
    expect(isValidIpv4("")).toBe(false);
  });
});
