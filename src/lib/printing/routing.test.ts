import { describe, expect, it } from "vitest";
import {
  mapWindowsPrinterStatus,
  printerAcceptsDocument,
  resolvePrinter,
  shouldOpenDrawer,
  type RoutingPrinter,
} from "./routing";

function printer(overrides: Partial<RoutingPrinter> = {}): RoutingPrinter {
  return {
    id: "p1",
    name: "صندوق",
    purpose: "receipt",
    printerClass: "thermal",
    isActive: true,
    isDefault: false,
    needsReconnect: false,
    supportsDrawer: false,
    ...overrides,
  };
}

describe("resolvePrinter", () => {
  const receipt = printer({ id: "r", isDefault: true });
  const backup = printer({ id: "b", name: "پشتیبان" });
  const kitchen = printer({ id: "k", name: "آشپزخانه", purpose: "kitchen" });
  const laser = printer({ id: "h", name: "HP", purpose: "document", printerClass: "page" });

  it("prefers the printer the action named", () => {
    const result = resolvePrinter({
      documentType: "receipt",
      printers: [receipt, backup],
      requestedPrinterId: "b",
    });
    expect(result.printer?.id).toBe("b");
    expect(result.reason).toBe("explicit");
  });

  it("uses the document rule before the default", () => {
    const result = resolvePrinter({
      documentType: "receipt",
      printers: [receipt, backup],
      rules: [{ documentType: "receipt", printerId: "b", fallbackPrinterId: null, templateKey: "thermal80-receipt", templateId: null }],
    });
    expect(result.printer?.id).toBe("b");
    expect(result.templateKey).toBe("thermal80-receipt");
    expect(result.reason).toBe("rule");
  });

  it("falls back only to a compatible backup", () => {
    const offline = printer({ id: "r", isActive: false, isDefault: true });
    const result = resolvePrinter({
      documentType: "receipt",
      printers: [offline, backup, kitchen],
      rules: [{ documentType: "receipt", printerId: "r", fallbackPrinterId: "b", templateKey: null, templateId: null }],
    });
    expect(result.printer?.id).toBe("b");
    expect(result.reason).toBe("fallback");
    expect(result.fallbackFrom?.id).toBe("r");
  });

  it("does not send an invoice to a kitchen printer", () => {
    const result = resolvePrinter({
      documentType: "invoice",
      printers: [kitchen, laser],
      rules: [{ documentType: "invoice", printerId: "k", fallbackPrinterId: null, templateKey: null, templateId: null }],
    });
    expect(result.printer?.id).toBe("h");
    expect(result.reason).toBe("only");
  });

  it("asks when nothing compatible is configured", () => {
    const result = resolvePrinter({ documentType: "invoice", printers: [receipt, kitchen] });
    expect(result.printer).toBeNull();
    expect(result.reason).toBe("choose");
  });

  it("uses the only compatible printer", () => {
    expect(resolvePrinter({ documentType: "kitchen", printers: [receipt, kitchen] }).printer?.id).toBe("k");
  });
});

describe("shouldOpenDrawer", () => {
  it("pulses once for a cash sale on a drawer printer", () => {
    expect(shouldOpenDrawer({ paymentIncludesCash: true, isReprint: false, supportsDrawer: true })).toBe(true);
  });

  it("does not pulse on reprint, card, or a printer without a drawer", () => {
    expect(shouldOpenDrawer({ paymentIncludesCash: true, isReprint: true, supportsDrawer: true })).toBe(false);
    expect(shouldOpenDrawer({ paymentIncludesCash: false, isReprint: false, supportsDrawer: true })).toBe(false);
    expect(shouldOpenDrawer({ paymentIncludesCash: true, isReprint: false, supportsDrawer: false })).toBe(false);
  });
});

describe("mapWindowsPrinterStatus", () => {
  it("does not call a queue ready just because it exists", () => {
    expect(mapWindowsPrinterStatus({})).toBe("unknown");
    expect(mapWindowsPrinterStatus({ printerStatus: 3, workOffline: false })).toBe("ready");
    expect(mapWindowsPrinterStatus({ workOffline: true, printerStatus: 3 })).toBe("offline");
    expect(mapWindowsPrinterStatus({ printerStatus: 6 })).toBe("paused");
  });
});

describe("printerAcceptsDocument", () => {
  it("keeps page printers off thermal receipts", () => {
    const laser = printer({ purpose: "document", printerClass: "page" });
    expect(printerAcceptsDocument(laser, "invoice")).toBe(true);
    expect(printerAcceptsDocument(laser, "receipt")).toBe(false);
    expect(printerAcceptsDocument(printer({ needsReconnect: true }), "receipt")).toBe(false);
  });
});
