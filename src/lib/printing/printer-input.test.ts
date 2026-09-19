/**
 * printer-input.ts — the printers write boundary. What must never regress:
 *
 *  - only the canonical hardware model passes: `windows` (queue name) or
 *    `network` (IPv4 + port). Every legacy transport spelling is refused, so
 *    new rows can only ever be ones the new architecture can print;
 *  - behavioural fields (paper/template/drawer/default) are normalised and
 *    never blank a partial edit;
 *  - the NUL bytes printer firmware pads its descriptors with cannot reach
 *    PostgreSQL (it rejects \u0000 in jsonb).
 */
import { describe, expect, it } from "vitest";
import { connectionJsonFor, parsePrinterInput } from "./printer-input";

describe("parsePrinterInput — the canonical model only", () => {
  it("accepts a windows printer with just a queue name", () => {
    const input = parsePrinterInput({ name: "چاپگر صندوق", kind: "receipt", connection: { type: "windows", systemName: "EPSON TM-T20III" } });
    expect(input).not.toBeNull();
    expect(input!.connection).toEqual({ type: "windows", systemName: "EPSON TM-T20III" });
    expect(input!.paperWidthMm).toBe(80);
  });

  it("accepts a network printer, defaulting the port to 9100", () => {
    const input = parsePrinterInput({ name: "چاپگر شبکه", kind: "kitchen", connection: { type: "network", ip: "192.168.1.45" } });
    expect(input!.connection).toEqual({ type: "network", ip: "192.168.1.45", port: 9100 });
  });

  it("rejects a network printer without a valid IPv4", () => {
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "network", ip: "" } })).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "network", ip: "printer.lan" } })).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "network", ip: "10.0.0.9", port: 99999 } })).toBeNull();
  });

  it("rejects a windows printer without a queue name", () => {
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "windows" } })).toBeNull();
  });

  it("refuses every legacy transport spelling — no new usb/webusb/browser rows", () => {
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "usb", devicePath: "USB001" } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "webusb", usbVendorId: 0x04b8 } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "browser" } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "system", systemName: "EPSON" } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", transport: "network", ip: "10.0.0.1" } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", connection: { type: "usb", devicePath: "USB001" } as never })).toBeNull();
  });

  it("rejects a missing name, an unknown kind and an out-of-range paper width", () => {
    expect(parsePrinterInput({ name: "", kind: "receipt", connection: { type: "windows", systemName: "EPSON" } })).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "label", connection: { type: "windows", systemName: "EPSON" } } as never)).toBeNull();
    expect(parsePrinterInput({ name: "x", kind: "receipt", paperWidthMm: 62, connection: { type: "windows", systemName: "EPSON" } })).toBeNull();
  });
});

describe("parsePrinterInput — behaviour fields", () => {
  it("derives the paper from the chosen roll width", () => {
    expect(parsePrinterInput({ name: "x", kind: "receipt", paperWidthMm: 58, connection: { type: "windows", systemName: "E" } })!.paper).toBe("thermal58");
    expect(parsePrinterInput({ name: "x", kind: "receipt", paperWidthMm: 80, connection: { type: "windows", systemName: "E" } })!.paper).toBe("thermal80");
  });

  it("never marks an inactive printer as the default for its kind", () => {
    const input = parsePrinterInput({ name: "x", kind: "receipt", isActive: false, isDefault: true, connection: { type: "windows", systemName: "E" } });
    expect(input!.isActive).toBe(false);
    expect(input!.isDefault).toBe(false);
  });

  it("keeps the stored template/drawer/default when a partial edit omits them", () => {
    const input = parsePrinterInput(
      { name: "نام جدید", kind: "receipt", connection: { type: "network", ip: "10.0.0.9" } },
      {
        name: "old",
        kind: "receipt",
        connection: { type: "network", ip: "10.0.0.9", port: 9100, templateKey: "compact58", openDrawer: true, isDefault: true, paperWidthMm: 58 },
        is_active: true,
      },
    );
    expect(input!.templateKey).toBe("compact58");
    expect(input!.openDrawer).toBe(true);
    expect(input!.isDefault).toBe(true);
    expect(input!.paperWidthMm).toBe(58);
  });

  it("strips NUL padding printer firmware reports in its strings (Postgres rejects \\u0000 in jsonb)", () => {
    const input = parsePrinterInput({
      name: "EPSON\u0000\u0000",
      kind: "receipt",
      connection: { type: "windows", systemName: "TM-T20\u0000\u0000" },
    });
    expect(input!.name).toBe("EPSON");
    expect(input!.connection.systemName).toBe("TM-T20");
    expect(JSON.stringify(connectionJsonFor(input!))).not.toContain("\\u0000");
  });

  it("produces the stored jsonb shape: target keys plus the behavioural keys", () => {
    const input = parsePrinterInput({
      name: "x",
      kind: "receipt",
      paperWidthMm: 58,
      openDrawer: true,
      isDefault: true,
      templateKey: "kitchen80",
      connection: { type: "network", ip: "10.0.0.9", port: 9101 },
    });
    expect(connectionJsonFor(input!)).toEqual({
      type: "network",
      ip: "10.0.0.9",
      port: 9101,
      paperWidthMm: 58,
      paper: "thermal58",
      templateKey: "kitchen80",
      openDrawer: true,
      isDefault: true,
    });
  });
});
