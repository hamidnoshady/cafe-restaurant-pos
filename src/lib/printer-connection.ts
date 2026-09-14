/**
 * Shared shape of `printers.connection` (migration 0001's flexible jsonb
 * column: "ip/port/usb path/driver opts") — used by both the browser
 * (print-agent-client.ts, telling the local agent which printer to use) and
 * the print agent itself (print-agent/transport.ts, opening the socket).
 * Pure/no I/O, so it lives in src/lib rather than print-agent/.
 *
 * A printer is reached one of four ways, and which one it is decides both how
 * bytes get to it and what the settings screen must ask for:
 *
 *   `network` — a LAN/Wi-Fi ESC/POS printer with its own IP, listening on the
 *     de-facto raw-print port 9100. The original and still the default.
 *   `system`  — a printer already installed on the Windows/macOS/Linux box the
 *     print agent runs on (the ones the OS lists: USB receipt printers, a
 *     shared network queue, a laser printer with a vendor driver). The agent
 *     enumerates them and prints by queue name, so the person setting it up
 *     picks from a list instead of hunting for an IP.
 *   `usb`     — a raw USB/serial device path (`USB001`, `/dev/usb/lp0`) for a
 *     printer with no OS driver worth using.
 *   `webusb`  — the browser itself as the delivery middleman: the app server
 *     renders the ESC/POS job (it has the Chromium raster pipeline) and the
 *     browser hands the bytes to a USB receipt printer over WebUSB. This is
 *     the transport for a *server* installation — the app server runs
 *     somewhere the printers are not, no local agent is installed, but the
 *     browser is physically on the till next to the printer. No dialog opens.
 *   `browser` — no hardware path at all: the document opens in the browser's
 *     own print dialog. This is what makes an A4 invoice printable from a
 *     tablet, a phone, or a till whose printer nobody has paired yet, and it
 *     is why the printing section works before any hardware exists.
 */

export type PrinterTransport = "network" | "system" | "usb" | "webusb" | "browser";

export const PRINTER_TRANSPORT_LABELS: Record<PrinterTransport, string> = {
  network: "شبکه (LAN / Wi-Fi)",
  system: "چاپگر نصب‌شده روی ویندوز",
  usb: "USB / پورت مستقیم",
  webusb: "USB از طریق مرورگر (WebUSB)",
  browser: "چاپ با مرورگر (بدون عامل چاپ)",
};

/**
 * How the agent should send a job to a `system` printer.
 *  `raster` — screenshot the HTML and send an ESC/POS raster (thermal).
 *  `document` — hand the HTML to the OS spooler as a page (A4/A5 on a laser).
 */
export type DriverMode = "raster" | "document";

export interface PrinterConnection {
  /** Absent on rows written before this field existed → treated as `network`. */
  transport?: PrinterTransport;
  ip?: string | null;
  /** ESC/POS network printers listen on 9100 by default. */
  port?: number | null;
  /** `system`: the OS queue name exactly as the spooler reports it. */
  systemName?: string | null;
  /** `usb`: the raw device path / port name. */
  devicePath?: string | null;
  /** `webusb`: the paired device's USB vendor id — how the browser re-finds it without re-prompting. */
  usbVendorId?: number | null;
  /** `webusb`: the paired device's USB product id. */
  usbProductId?: number | null;
  /** `webusb`: the paired device's serial number, when it reports one — disambiguates two identical printers. */
  usbSerial?: string | null;
  /** `webusb`: the product name shown at pairing time, kept for the hardware list. */
  usbProductName?: string | null;
  driverMode?: DriverMode;
  /** 58mm or 80mm thermal paper; defaults to 80mm if unset. Kept for the ESC/POS raster path. */
  paperWidthMm?: 58 | 80;
  /** Paper key from print-template.ts — what this printer is actually loaded with. */
  paper?: string | null;
  /** Template (built-in key or saved row id) this printer prints with by default. */
  templateKey?: string | null;
  /** Open the cash drawer after a receipt prints on this printer. */
  openDrawer?: boolean;
  /** Copies to print per job. */
  copies?: number;
  /** Selected printer for its kind within a branch. */
  isDefault?: boolean;
}

export function resolvedTransport(conn: PrinterConnection): PrinterTransport {
  const value = conn.transport;
  return value === "system" || value === "usb" || value === "webusb" || value === "browser" ? value : "network";
}

/**
 * Whether a connection names a reachable target for its transport. Network
 * needs an IP, a system printer needs a queue name, USB needs a path; the
 * browser transport needs nothing at all, which is the point of it.
 */
export function isValidPrinterConnection(conn: unknown): conn is PrinterConnection {
  if (!conn || typeof conn !== "object") return false;
  const c = conn as PrinterConnection;
  switch (resolvedTransport(c)) {
    case "network":
      if (typeof c.ip !== "string" || c.ip.trim() === "") return false;
      if (c.port != null && typeof c.port !== "number") return false;
      return true;
    case "system":
      return typeof c.systemName === "string" && c.systemName.trim() !== "";
    case "usb":
      return typeof c.devicePath === "string" && c.devicePath.trim() !== "";
    case "webusb":
      // The vendor id is the one thing pairing always yields; product id and
      // serial narrow the match down when present.
      return typeof c.usbVendorId === "number" && Number.isInteger(c.usbVendorId) && c.usbVendorId > 0;
    case "browser":
      return true;
  }
}

export function resolvedPort(conn: PrinterConnection): number {
  return Number.isInteger(conn.port) && (conn.port as number) > 0 ? (conn.port as number) : 9100;
}

export function resolvedPaperWidthMm(conn: PrinterConnection): 58 | 80 {
  return conn.paperWidthMm === 58 ? 58 : 80;
}

export function resolvedDriverMode(conn: PrinterConnection): DriverMode {
  return conn.driverMode === "document" ? "document" : "raster";
}

/** A one-line description of where a printer is, for the hardware list. */
export function describeConnection(conn: PrinterConnection): string {
  switch (resolvedTransport(conn)) {
    case "network":
      return `${conn.ip ?? "—"}:${resolvedPort(conn)}`;
    case "system":
      return conn.systemName ?? "—";
    case "usb":
      return conn.devicePath ?? "—";
    case "webusb": {
      if (conn.usbProductName) return conn.usbProductName;
      const vid = typeof conn.usbVendorId === "number" ? conn.usbVendorId.toString(16).padStart(4, "0") : "????";
      const pid = typeof conn.usbProductId === "number" ? conn.usbProductId.toString(16).padStart(4, "0") : "????";
      return `USB ${vid}:${pid}`;
    }
    case "browser":
      return "پنجرهٔ چاپ مرورگر";
  }
}
