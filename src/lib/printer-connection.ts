/**
 * Shared shape of `printers.connection` (migration 0001's flexible jsonb
 * column: "ip/port/usb path/driver opts") — used by both the browser
 * (print-agent-client.ts, telling the local agent which printer to use) and
 * the print agent itself (print-agent/transport.ts, opening the socket).
 * Pure/no I/O, so it lives in src/lib rather than print-agent/.
 */
export interface PrinterConnection {
  ip?: string | null;
  /** ESC/POS network printers listen on 9100 by default. */
  port?: number | null;
  /** 58mm or 80mm thermal paper; defaults to 80mm if unset. */
  paperWidthMm?: 58 | 80;
}

export function isValidPrinterConnection(conn: unknown): conn is PrinterConnection {
  if (!conn || typeof conn !== "object") return false;
  const c = conn as Record<string, unknown>;
  if (c.ip == null || typeof c.ip !== "string" || c.ip.trim() === "") return false;
  if (c.port != null && typeof c.port !== "number") return false;
  return true;
}

export function resolvedPort(conn: PrinterConnection): number {
  return Number.isInteger(conn.port) && (conn.port as number) > 0 ? (conn.port as number) : 9100;
}

export function resolvedPaperWidthMm(conn: PrinterConnection): 58 | 80 {
  return conn.paperWidthMm === 58 ? 58 : 80;
}
