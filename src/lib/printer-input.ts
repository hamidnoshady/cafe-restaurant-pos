/**
 * The `printers` write boundary — one parser, shared by POST /api/settings/printers
 * and PATCH /api/settings/printers/[id].
 *
 * It lives here rather than in either route because the two used to hold
 * near-identical copies, and they had already drifted (the collection route
 * clamped the IP length, the item route did not). With four transports and a
 * paper/template/drawer choice each, a second copy is a guarantee of a third
 * bug. Pure: everything it needs arrives as arguments, so it is testable as
 * plain data.
 */
import {
  isValidPrinterConnection,
  type PrinterConnection,
  type PrinterTransport,
} from "./printer-connection";
import { isPaperKey } from "./print-template";

export interface PrinterInput {
  name: string;
  kind: "receipt" | "kitchen";
  connection: PrinterConnection;
  isActive: boolean;
  isDefault: boolean;
}

export interface ExistingPrinter {
  name: string;
  kind: "receipt" | "kitchen";
  connection: PrinterConnection;
  is_active: boolean;
}

/**
 * Normalise a printer payload into the `connection` jsonb migration 0001 set
 * aside for exactly this ("ip/port/usb path/driver opts"). The transport
 * decides which field is required — a Windows queue has no IP, and the
 * browser transport has nothing at all — so validation branches on it rather
 * than demanding an address from every printer.
 */
export function parsePrinterInput(
  body: Record<string, unknown>,
  fallback?: ExistingPrinter,
): PrinterInput | null {
  // Strip control characters before anything is stored. USB printer firmware
  // routinely pads its descriptor strings (serial, product name) with NUL
  // bytes, and PostgreSQL rejects \u0000 in jsonb outright (error 22P05:
  // "\u0000 cannot be converted to text") — so a paired printer whose serial
  // was "VNBV9BJGLG\0\0…" made every save 500 until the bytes are dropped
  // here, at the one write boundary both routes share.
  const stripControls = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "");

  const nameValue = body.name ?? fallback?.name;
  const name = typeof nameValue === "string" ? stripControls(nameValue).trim() : "";
  const kindValue = body.kind ?? fallback?.kind;
  const kind = kindValue === "kitchen" ? "kitchen" : kindValue === "receipt" ? "receipt" : null;
  const existing: PrinterConnection = fallback?.connection ?? {};

  const transportValue = body.transport ?? existing.transport ?? "network";
  const transport: PrinterTransport =
    transportValue === "system" || transportValue === "usb" || transportValue === "webusb" || transportValue === "browser"
      ? transportValue
      : "network";

  const text = (value: unknown, previous: string | null | undefined) =>
    stripControls(typeof value === "string" ? value.trim() : (previous ?? "")).slice(0, 255);

  const ip = text(body.ip, existing.ip);
  const systemName = text(body.systemName, existing.systemName);
  const devicePath = text(body.devicePath, existing.devicePath);

  // `webusb` — the pairing chooser's identifiers. USB vendor/product ids are
  // 16-bit; anything else is a malformed payload rather than a device.
  const usbId = (value: unknown, previous: number | null | undefined): number | null => {
    const n = typeof value === "number" ? value : (previous ?? null);
    return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 0xffff ? n : null;
  };
  const usbVendorId = usbId(body.usbVendorId, existing.usbVendorId);
  const usbProductId = usbId(body.usbProductId, existing.usbProductId);
  const usbSerial = text(body.usbSerial, existing.usbSerial) || null;
  const usbProductName = text(body.usbProductName, existing.usbProductName) || null;
  const port = Number(body.port ?? existing.port ?? 9100);
  const paperWidthMm = Number(body.paperWidthMm ?? existing.paperWidthMm ?? 80);
  const paperValue = body.paper ?? existing.paper;
  const paper = isPaperKey(paperValue) ? paperValue : paperWidthMm === 58 ? "thermal58" : "thermal80";
  const driverMode = (body.driverMode ?? existing.driverMode) === "document" ? "document" : "raster";
  const templateValue = body.templateKey ?? existing.templateKey;
  const templateKey = typeof templateValue === "string" && templateValue.trim() ? stripControls(templateValue).trim().slice(0, 64) : null;
  const openDrawer = typeof body.openDrawer === "boolean" ? body.openDrawer : existing.openDrawer === true;
  const isActive = typeof body.isActive === "boolean" ? body.isActive : (fallback?.is_active ?? true);
  const isDefault = (typeof body.isDefault === "boolean" ? body.isDefault : (existing.isDefault === true)) && isActive;

  if (!name || name.length > 200 || !kind) return null;
  if (paperWidthMm !== 58 && paperWidthMm !== 80) return null;
  if (transport === "network" && (!ip || !Number.isInteger(port) || port < 1 || port > 65535)) return null;
  if (transport === "system" && !systemName) return null;
  if (transport === "usb" && !devicePath) return null;
  if (transport === "webusb" && !usbVendorId) return null;

  const connection: PrinterConnection = {
    ...existing,
    transport,
    ip: ip || null,
    port: Number.isInteger(port) ? port : 9100,
    systemName: systemName || null,
    devicePath: devicePath || null,
    usbVendorId,
    usbProductId,
    usbSerial,
    usbProductName,
    paper,
    paperWidthMm: paperWidthMm as 58 | 80,
    driverMode,
    templateKey,
    openDrawer,
    isDefault,
  };
  if (!isValidPrinterConnection(connection)) return null;

  return { name, kind, isActive, isDefault, connection };
}

