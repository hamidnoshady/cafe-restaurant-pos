/**
 * The canonical printer model — ONE hardware question, two answers.
 *
 * A restaurant employee should never have to understand print agents,
 * WebUSB, driver modes, device paths, port numbers or spoolers. The product
 * asks exactly one question — «چاپگر کجاست؟» — and accepts exactly two
 * answers:
 *
 *   `windows` — a printer already installed in Windows' own
 *     «Bluetooth & devices → Printers & scanners» list. USB thermal printers
 *     belong here: Windows owns the cable, and the Cafe POS Windows connector
 *     prints through the native RAW spooler. No IP, no driver choice.
 *   `network` — a LAN/Wi-Fi/Ethernet ESC/POS printer with its own address,
 *     listening on the de-facto raw-print port 9100. The same local
 *     connector discovers it and delivers bytes over TCP.
 *
 * Everything transport-related lives in this module's `PrinterConnection`;
 * everything behavioural (paper, template, drawer, defaults) is carried
 * alongside it in the stored `connection` jsonb but is deliberately NOT part
 * of the hardware target — see `PrinterTarget`, the only shape the browser
 * ever hands the local connector.
 *
 * Legacy rows written by the old five-transport model are normalised here,
 * never re-written by new code: `system` and `network` map cleanly, and
 * anything else (`usb`, `webusb`, `browser`, or a pre-transport stub) is
 * flagged `needsReconnect` so the settings UI can ask for one new pairing
 * instead of guessing where the printer went.
 */
import { isPaperKey, type PaperKey } from "../print-template";

/** The two hardware connection types exposed to users. */
export type PrinterConnectionType = "windows" | "network";

export type PrinterPurpose = "receipt" | "kitchen";

/**
 * The hardware half of a stored printer — where the bytes physically go.
 * This is the ONLY shape normal print code may construct; POS/order/kitchen
 * callers pass a saved printer ID and the server resolves this from the
 * database for the authenticated tenant + branch.
 */
export interface PrinterConnection {
  type: PrinterConnectionType;
  /** `windows`: the queue name exactly as Windows' Printers & scanners shows it. */
  systemName?: string;
  /** `network`: the printer's IPv4 address on the café LAN. */
  ip?: string;
  /** `network`: raw-print port, 9100 by convention. */
  port?: number;
}

/**
 * The wire shape the browser sends to the local Cafe POS connector — the
 * connection stripped of every behavioural field, because the connector
 * moves bytes and nothing else.
 */
export type PrinterTarget = PrinterConnection;

/** The behavioural half — what the printer prints, not where it is. */
export interface PrinterSettings {
  purpose: PrinterPurpose;
  paperWidthMm: 58 | 80;
  paper: PaperKey;
  templateKey?: string | null;
  openDrawer: boolean;
  isDefault: boolean;
  isActive: boolean;
}

/** A `printers` row as the application reads it. */
export interface StoredPrinter extends Record<string, unknown> {
  id: string;
  name: string;
  kind: PrinterPurpose;
  connection: StoredPrinterConnection;
  is_active: boolean;
}

/**
 * What actually sits in the `printers.connection` jsonb column: the hardware
 * target plus the behavioural fields that ride along in the same column
 * (keeping them there was the smallest safe migration). `needsReconnect` rows
 * keep their legacy identifying fields so an operator can still tell which
 * physical printer needs re-pairing.
 */
export interface StoredPrinterConnection extends Partial<PrinterSettings> {
  type?: PrinterConnectionType;
  systemName?: string | null;
  ip?: string | null;
  port?: number | null;
  /** Set on legacy rows that could not be mapped to the canonical model. */
  needsReconnect?: boolean;
  /** The legacy transport a `needsReconnect` row was saved with. */
  legacyTransport?: string;
  /** The pre-migration transport spelling — read by the normaliser, never written by new code. */
  transport?: string | null;
  /** Legacy fields preserved for identification only; never written by new code. */
  devicePath?: string | null;
  usbProductName?: string | null;
  usbVendorId?: number | null;
}

/* ────────────────────────── normalisation ────────────────────────── */

/**
 * Read any stored connection — including rows written by the old
 * five-transport model — into the canonical model. Pure, best-effort and
 * total: every input yields either a usable target or `needsReconnect`.
 *
 *   `system`                → windows (queue name)
 *   `network` / ip-only     → network (ip, port)
 *   `usb` / `webusb` / `browser` / stub rows → needsReconnect, with the
 *   identifying information preserved so the operator recognises the printer.
 */
export function normalizeStoredConnection(raw: unknown): StoredPrinterConnection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { needsReconnect: true, legacyTransport: "unknown" };
  }
  const c = raw as Record<string, unknown> & StoredPrinterConnection;

  const legacyTransport =
    typeof c.transport === "string" && c.transport !== "" ? c.transport : null;

  // Canonical rows (written after the migration): trust the type field.
  if (c.type === "windows" || c.type === "network") {
    return stripBehavioralDefaults({
      ...c,
      type: c.type,
      systemName: typeof c.systemName === "string" && c.systemName.trim() !== "" ? c.systemName : null,
      ip: typeof c.ip === "string" && c.ip.trim() !== "" ? c.ip.trim() : null,
      port: Number.isInteger(c.port) && (c.port as number) > 0 ? (c.port as number) : null,
    });
  }

  const text = (value: unknown): string | null =>
    typeof value === "string" && value.trim() !== "" ? value.trim() : null;

  if (legacyTransport === "system") {
    const systemName = text(c.systemName);
    if (systemName) return { ...c, type: "windows", transport: undefined, systemName, needsReconnect: undefined, legacyTransport: undefined };
    return { ...c, needsReconnect: true, legacyTransport: "system", transport: undefined };
  }

  if (legacyTransport === "network" || (!legacyTransport && text(c.ip))) {
    const ip = text(c.ip);
    if (ip) {
      return {
        ...c,
        type: "network",
        transport: undefined,
        systemName: null,
        ip,
        port: Number.isInteger(c.port) && (c.port as number) > 0 ? (c.port as number) : null,
        needsReconnect: undefined,
        legacyTransport: undefined,
      };
    }
  }

  // `usb`, `webusb`, `browser`, or a pre-transport stub with no address:
  // not safely convertible — ask for one new pairing, keep the identity.
  return {
    ...c,
    transport: undefined,
    needsReconnect: true,
    legacyTransport: legacyTransport ?? "unknown",
  };
}

/** Drop `undefined` keys jsonb round-trips would not have kept anyway. */
function stripBehavioralDefaults(c: StoredPrinterConnection): StoredPrinterConnection {
  const next = { ...c };
  if (next.needsReconnect === undefined) delete next.needsReconnect;
  if (next.legacyTransport === undefined) delete next.legacyTransport;
  return next;
}

/* ────────────────────────── validation ────────────────────────── */

/**
 * Does a connection name a usable hardware target? Windows needs the queue
 * name; network needs an IPv4 address. Used at the settings write boundary
 * and by anything about to hand a target to the connector.
 */
export function isValidPrinterConnection(conn: unknown): conn is PrinterConnection {
  if (!conn || typeof conn !== "object") return false;
  const c = conn as Record<string, unknown>;
  if (c.type === "windows") return typeof c.systemName === "string" && c.systemName.trim() !== "";
  if (c.type === "network") {
    if (typeof c.ip !== "string" || !isValidIpv4(c.ip.trim())) return false;
    if (c.port != null && (!Number.isInteger(c.port) || (c.port as number) < 1 || (c.port as number) > 65535)) return false;
    return true;
  }
  return false;
}

/** Strict IPv4 — the connector dials this, so no hostnames and no surprises. */
export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

/** ESC/POS network printers listen on 9100 unless configured otherwise. */
export function resolvedPort(conn: { port?: number | null }): number {
  return Number.isInteger(conn.port) && (conn.port as number) > 0 ? (conn.port as number) : 9100;
}

/** 58mm or 80mm thermal paper; rows without a width print at 80mm. */
export function resolvedPaperWidthMm(conn: { paperWidthMm?: number | null; paper?: string | null }): 58 | 80 {
  if (conn.paperWidthMm === 58) return 58;
  if (isPaperKey(conn.paper) && conn.paper === "thermal58") return 58;
  return 80;
}

/** The one-line answer to «this printer is where?» for a card or a list. */
export function describeConnection(conn: StoredPrinterConnection): string {
  const normalized = normalizeStoredConnection(conn);
  if (normalized.needsReconnect) return legacyDescription(normalized);
  if (normalized.type === "windows") return normalized.systemName ?? "—";
  return normalized.ip ?? "—";
}

/** Human words for a legacy transport, so the reconnect card can say what it was. */
export function legacyTransportLabel(transport: string | undefined): string {
  switch (transport) {
    case "usb":
      return "USB مستقیم (قدیمی)";
    case "webusb":
      return "USB از طریق مرورگر (قدیمی)";
    case "browser":
      return "چاپ با مرورگر (قدیمی)";
    default:
      return "اتصال نامشخص (قدیمی)";
  }
}

function legacyDescription(conn: StoredPrinterConnection): string {
  const where =
    conn.usbProductName ? conn.usbProductName : conn.systemName ? conn.systemName : conn.devicePath ? conn.devicePath : conn.ip ? conn.ip : null;
  return where ?? legacyTransportLabel(conn.legacyTransport);
}

/** The target a connection resolves to, or null when it needs reconnection. */
export function printerTargetOf(conn: StoredPrinterConnection): PrinterTarget | null {
  const normalized = normalizeStoredConnection(conn);
  if (normalized.needsReconnect || !isValidPrinterConnection(normalized)) return null;
  if (normalized.type === "windows") return { type: "windows", systemName: normalized.systemName };
  return { type: "network", ip: normalized.ip!.trim(), port: resolvedPort(normalized) };
}
