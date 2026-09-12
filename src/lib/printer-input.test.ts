import { describe, expect, it } from "vitest";
import { parsePrinterInput } from "./printer-input";

const base = { name: "چاپگر صندوق", kind: "receipt" };

describe("parsePrinterInput", () => {
  it("keeps the network printer the old screen used to write", () => {
    const input = parsePrinterInput({ ...base, ip: "192.168.1.50", port: 9100, paperWidthMm: 80 })!;
    expect(input.connection.transport).toBe("network");
    expect(input.connection.ip).toBe("192.168.1.50");
    expect(input.connection.paper).toBe("thermal80");
  });

  it("accepts a Windows queue with no IP at all", () => {
    const input = parsePrinterInput({ ...base, transport: "system", systemName: "EPSON TM-T20III" })!;
    expect(input.connection.systemName).toBe("EPSON TM-T20III");
    expect(input.connection.ip).toBeNull();
  });

  it("accepts the browser transport with nothing configured", () => {
    expect(parsePrinterInput({ ...base, transport: "browser" })).not.toBeNull();
  });

  it("rejects a transport whose own required field is missing", () => {
    expect(parsePrinterInput({ ...base, transport: "network", ip: "" })).toBeNull();
    expect(parsePrinterInput({ ...base, transport: "system", systemName: "  " })).toBeNull();
    expect(parsePrinterInput({ ...base, transport: "usb" })).toBeNull();
  });

  it("rejects a missing name, an unknown kind and an out-of-range port", () => {
    expect(parsePrinterInput({ kind: "receipt", ip: "10.0.0.1" })).toBeNull();
    expect(parsePrinterInput({ ...base, kind: "banner", ip: "10.0.0.1" })).toBeNull();
    expect(parsePrinterInput({ ...base, ip: "10.0.0.1", port: 70_000 })).toBeNull();
  });

  it("derives the ESC/POS raster width from the chosen paper, and the driver from its kind", () => {
    const thermal = parsePrinterInput({ ...base, ip: "10.0.0.1", paper: "thermal58", paperWidthMm: 58 })!;
    expect(thermal.connection.paperWidthMm).toBe(58);
    const sheet = parsePrinterInput({
      ...base,
      transport: "system",
      systemName: "HP LaserJet",
      paper: "a4",
      driverMode: "document",
    })!;
    expect(sheet.connection.paper).toBe("a4");
    expect(sheet.connection.driverMode).toBe("document");
  });

  it("falls back to a known paper when the payload names one that does not exist", () => {
    const input = parsePrinterInput({ ...base, ip: "10.0.0.1", paper: "a3", paperWidthMm: 80 })!;
    expect(input.connection.paper).toBe("thermal80");
  });

  it("never marks an inactive printer as the default for its kind", () => {
    const input = parsePrinterInput({ ...base, ip: "10.0.0.1", isActive: false, isDefault: true })!;
    expect(input.isDefault).toBe(false);
    expect(input.connection.isDefault).toBe(false);
  });

  it("merges a partial edit onto the stored connection instead of blanking it", () => {
    const input = parsePrinterInput(
      { name: "نام تازه" },
      {
        name: "قدیمی",
        kind: "kitchen",
        connection: { transport: "network", ip: "10.0.0.9", port: 9101, paper: "thermal58", paperWidthMm: 58 },
        is_active: true,
      },
    )!;
    expect(input.name).toBe("نام تازه");
    expect(input.kind).toBe("kitchen");
    expect(input.connection.ip).toBe("10.0.0.9");
    expect(input.connection.port).toBe(9101);
    expect(input.connection.paper).toBe("thermal58");
  });
});
