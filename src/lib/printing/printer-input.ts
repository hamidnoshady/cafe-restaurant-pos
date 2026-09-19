/**
 * The `printers` write boundary — one parser, shared by POST /api/settings/printers
 * and PATCH /api/settings/printers/[id]. Pure: everything it needs arrives as
 * arguments, so it is testable as plain data.
 *
 * Only the canonical hardware model passes: `windows` (queue name) or
 * `network` (IPv4 + port). The legacy transports (`usb`, `webusb`,
 * `browser`, and the old `transport` spelling) are rejected outright — new
 * writes must never create rows the new architecture cannot print.
 */
import { isPaperKey } from "../print-template";
import { isValidPrinterConnection, type PrinterConnection, type PrinterPurpose } from "./types";

export interface PrinterInput {
  name: string;
  kind: PrinterPurpose;
  connection: PrinterConnection;
  paperWidthMm: 58 | 80;
  paper: string;
  templateKey: string | null;
  openDrawer: boolean;
  isActive: boolean;
  isDefault: boolean;
}

export interface ExistingPrinter {
  name: string;
  kind: PrinterPurpose;
  connection: Record<string, unknown>;
  is_active: boolean;
}

/**
 * Normalise a printer payload into the stored shape. The behavioural fields
 * ride along in the same `connection` jsonb column the table has had since
 * migration 0001 — the smallest safe migration — but the hardware half is
 * strictly `windows` or `network`.
 */
export function parsePrinterInput(body: Record<string, unknown>, fallback?: ExistingPrinter): PrinterInput | null {
  // Strip control characters before anything is stored: printer descriptor
  // strings and pasted names can carry NUL bytes, and PostgreSQL rejects
  // \u0000 in jsonb outright (error 22P05).
  const stripControls = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "");

  const nameValue = body.name ?? fallback?.name;
  const name = typeof nameValue === "string" ? stripControls(nameValue).trim() : "";
  const kindValue = body.kind ?? fallback?.kind;
  const kind: PrinterPurpose | null = kindValue === "kitchen" ? "kitchen" : kindValue === "receipt" ? "receipt" : null;

  const existing = (fallback?.connection ?? {}) as Record<string, unknown>;
  const text = (value: unknown, previous: unknown) =>
    stripControls(typeof value === "string" ? value.trim() : typeof previous === "string" ? previous.trim() : "").slice(0, 255);

  // ── the hardware target ──
  const connectionBody = body.connection && typeof body.connection === "object" ? (body.connection as Record<string, unknown>) : body;
  const typeValue = connectionBody.type ?? body.type;
  const type = typeValue === "windows" ? "windows" : typeValue === "network" ? "network" : null;
  if (!type) return null; // includes every legacy transport spelling — refused

  const systemName = text(connectionBody.systemName ?? body.systemName, null);
  const ip = text(connectionBody.ip ?? body.ip, null);
  const portNumber = Number(connectionBody.port ?? body.port ?? 9100);

  const connection: PrinterConnection =
    type === "windows"
      ? { type, systemName: systemName || undefined }
      : { type, ip: ip || undefined, port: Number.isInteger(portNumber) ? portNumber : 9100 };

  if (!isValidPrinterConnection(connection)) return null;
  if (type === "windows" && connection.systemName) connection.systemName = connection.systemName.slice(0, 255);
  if (type === "network" && connection.ip) connection.ip = connection.ip.trim().slice(0, 64);

  // ── the behaviour ──
  const paperWidthValue = Number(body.paperWidthMm ?? existing.paperWidthMm ?? 80);
  const paperWidthMm = paperWidthValue === 58 ? 58 : paperWidthValue === 80 ? 80 : null;
  if (!paperWidthMm) return null;
  const paperValue = body.paper ?? existing.paper;
  const paper = isPaperKey(paperValue) ? paperValue : paperWidthMm === 58 ? "thermal58" : "thermal80";

  const templateValue = body.templateKey ?? existing.templateKey;
  const templateKey =
    typeof templateValue === "string" && templateValue.trim() ? stripControls(templateValue).trim().slice(0, 64) : null;

  const openDrawer = typeof body.openDrawer === "boolean" ? body.openDrawer : existing.openDrawer === true;
  const isActive = typeof body.isActive === "boolean" ? body.isActive : (fallback?.is_active ?? true);
  const isDefault = (typeof body.isDefault === "boolean" ? body.isDefault : existing.isDefault === true) && isActive;

  if (!name || name.length > 200 || !kind) return null;

  return { name, kind, connection, paperWidthMm, paper, templateKey, openDrawer, isActive, isDefault };
}

/** The jsonb written to `printers.connection` for a parsed input. */
export function connectionJsonFor(input: PrinterInput): Record<string, unknown> {
  return {
    ...input.connection,
    paperWidthMm: input.paperWidthMm,
    paper: input.paper,
    templateKey: input.templateKey,
    openDrawer: input.openDrawer,
    isDefault: input.isDefault,
  };
}
