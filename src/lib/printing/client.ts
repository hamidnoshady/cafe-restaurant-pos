/**
 * The browser's printing client — one hardware backend, one fallback.
 *
 * Hardware printing has exactly one path: the app server renders the
 * canonical ESC/POS bytes for a saved printer ID (POST /api/printing/print),
 * and THIS page hands them to the local Cafe POS connector on loopback, which
 * owns every printer the cashier's machine can reach (Windows queues and
 * network TCP alike). There is deliberately no agent/server/WebUSB/system
 * fallback chain to decide between: the connector is the hardware
 * abstraction, and if it is not running that fact is reported plainly
 * instead of being routed around.
 *
 * The no-hardware path stays: `printViaBrowser` opens the browser's own
 * print dialog on a rendered document — the right output for A4 invoices,
 * label sheets, and tills with no configured hardware printer. It is an
 * output action, not a printer connection type, and is never saved as one.
 */
import type { KitchenTicketData } from "../kitchen-ticket-template";
import { renderLabelHtml, type LabelData } from "../label-template";
import type { PaperKey } from "../print-template";
import type { ReceiptData } from "../receipt-template";
import { CONNECTOR_PROTOCOL_VERSION, CONNECTOR_PORT } from "./connector-release";
import { classifyDeliveryError, type PrinterErrorCode } from "./errors";
import type { PrintJob } from "./render-service";
import type { PrinterTarget } from "./types";

export type { PrintJob } from "./render-service";

/** The connector protocol version this client speaks — shared with the installer and docs. */
const CONNECTOR_VERSION = CONNECTOR_PROTOCOL_VERSION;

function connectorBaseUrl(): string {
  return process.env.NEXT_PUBLIC_PRINT_CONNECTOR_URL || `http://127.0.0.1:${CONNECTOR_PORT}`;
}

// A cloud page must not hammer a missing loopback service: one failed health
// attempt suppresses further calls for a short window, and the explicit
// «بررسی دوباره» action clears the backoff immediately after the operator
// installs the connector.
const CONNECTOR_RETRY_DELAY_MS = 15_000;
let connectorRetryAfter = 0;
let healthInFlight: Promise<ConnectorResult<ConnectorHealth>> | null = null;

/** Let an explicit user action retry the connector immediately. */
export function allowConnectorRetry(): void {
  connectorRetryAfter = 0;
}

export interface ConnectorResult<T = { ok: boolean }> {
  ok: boolean;
  /** The connector process itself was not reachable (not installed/not running). */
  unreachable?: boolean;
  error?: PrinterErrorCode;
  /** Technical detail for logs/diagnostics — never shown in the primary UI. */
  detail?: string;
  data?: T;
}

export interface ConnectorHealth {
  ok: boolean;
  service?: string;
  version?: number;
  release?: string;
  platform?: string;
  /** The primary origin the connector serves (kept from protocol v3). */
  allowedOrigin?: string;
  /** Every origin the connector serves — primary plus aliases (release 3.1+). */
  allowedOrigins?: string[];
  printSubsystem?: {
    winspool?: string;
    networkDiscovery?: string;
    spooler?: string;
  };
}

async function callConnector<T = { ok: boolean }>(
  path: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; method?: "GET" | "POST"; force?: boolean } = {},
): Promise<ConnectorResult<T>> {
  if (!opts.force && Date.now() < connectorRetryAfter) {
    return { ok: false, unreachable: true, error: "connector_not_installed" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  try {
    const method = opts.method ?? "POST";
    // The literal 127.0.0.1 target lets current Chromium identify this as a
    // loopback request before mixed-content checks and show its one-time
    // «Apps on device / Local network access» permission when needed.
    const res = await fetch(`${connectorBaseUrl()}${path}`, {
      method,
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    connectorRetryAfter = 0;
    let data: { ok?: boolean; error?: string; detail?: string } & Record<string, unknown> = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // no body
    }
    if (!res.ok) {
      return {
        ok: false,
        error: (data.error as PrinterErrorCode) ?? "print_failed",
        detail: typeof data.detail === "string" ? data.detail : undefined,
        data: data as T,
      };
    }
    return { ok: true, data: data as T };
  } catch {
    connectorRetryAfter = Date.now() + CONNECTOR_RETRY_DELAY_MS;
    return { ok: false, unreachable: true, error: "connector_not_installed" };
  } finally {
    clearTimeout(timeout);
  }
}

/* ─────────────────────────── connector API ─────────────────────────── */

/**
 * Is the local Cafe POS connector installed, running and current? A health
 * answer from an older connector version (pre-3) is `connector_outdated`:
 * the one-click reinstall upgrades it.
 */
export async function connectorHealth(opts: { force?: boolean } = {}): Promise<ConnectorResult<ConnectorHealth>> {
  if (healthInFlight && !opts.force) return healthInFlight;
  const probe = (async (): Promise<ConnectorResult<ConnectorHealth>> => {
    const result = await callConnector<ConnectorHealth>("/health", {}, {
      method: "GET",
      // A first cloud → loopback request may wait while Chrome/Edge shows
      // the one-time Local Network Access prompt. Give the operator time to
      // read and allow it; a genuinely closed port still refuses instantly.
      timeoutMs: 12_000,
      force: opts.force,
    });
    if (result.ok && typeof result.data?.version === "number" && result.data.version < CONNECTOR_VERSION) {
      return { ok: false, error: "connector_outdated", data: result.data };
    }
    return result;
  })();
  if (opts.force) return probe;
  healthInFlight = probe;
  void probe.finally(() => {
    if (healthInFlight === probe) healthInFlight = null;
  });
  return probe;
}

export interface WindowsPrinter {
  name: string;
  driver?: string | null;
  isDefault: boolean;
  likelyThermal: boolean;
}

/** The print queues installed on this Windows machine (Printers & scanners). */
export function listWindowsPrinters(): Promise<ConnectorResult<{ printers: WindowsPrinter[] }>> {
  return callConnector<{ printers: WindowsPrinter[] }>("/printers/windows", {}, { method: "GET", timeoutMs: 20_000 });
}

export interface DiscoveredPrinter {
  ip: string;
  port: number;
  latencyMs: number;
}

/** Sweep this machine's local subnets for network printers (port 9100). Runs on the connector, never on the app server. */
export function discoverNetworkPrinters(): Promise<ConnectorResult<{ printers: DiscoveredPrinter[] }>> {
  return callConnector<{ printers: DiscoveredPrinter[] }>("/printers/network/discover", {}, { timeoutMs: 60_000 });
}

/** Is this printer answering right now, as seen from the cashier's machine? */
export async function probePrinterTarget(
  target: PrinterTarget,
): Promise<ConnectorResult<{ reachable: boolean; detail?: string }>> {
  const result = await callConnector<{ reachable: boolean; detail?: string }>("/printers/probe", { target }, { timeoutMs: 10_000 });
  if (result.ok && !result.data?.reachable) {
    return { ...result, error: target.type === "network" ? "network_unreachable" : "printer_offline" };
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Deliver raw ESC/POS bytes to a printer through the local connector. */
export async function sendRawToPrinter(target: PrinterTarget, bytes: Uint8Array): Promise<ConnectorResult> {
  const result = await callConnector("/print/raw", { target, dataBase64: bytesToBase64(bytes) }, { timeoutMs: 30_000 });
  if (!result.ok && !result.unreachable) {
    // A refused queue or an unanswered TCP dial is a different sentence in
    // the operator's world; classify from the connector's detail.
    return { ...result, error: result.error ?? classifyDeliveryError(result.detail, target) };
  }
  return result;
}

/* ─────────────────────── job rendering (app server) ─────────────────────── */

export interface PrintResult {
  ok: boolean;
  error?: PrinterErrorCode;
  detail?: string;
}

interface RenderedJob {
  target: PrinterTarget;
  dataBase64: string;
}

/**
 * Render a job for a saved printer on the authenticated app server and
 * deliver the canonical bytes through the local connector. The server only
 * ever receives the printer ID — it resolves the hardware target from the
 * database for the caller's branch, so a hand-edited request can neither
 * print through another branch's printer nor turn the server into an
 * arbitrary TCP client.
 */
export async function printJob(printerId: string, job: PrintJob): Promise<PrintResult> {
  let rendered: RenderedJob;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const res = await fetch("/api/printing/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printerId, job }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = (await res.json()) as { ok?: boolean; error?: string; target?: PrinterTarget; dataBase64?: string };
    if (!res.ok || !data.ok || !data.target || !data.dataBase64) {
      return { ok: false, error: (data.error as PrinterErrorCode) ?? "render_failed" };
    }
    rendered = { target: data.target, dataBase64: data.dataBase64 };
  } catch {
    return { ok: false, error: "render_failed" };
  }
  const delivered = await sendRawToPrinter(rendered.target, base64ToBytes(rendered.dataBase64));
  return delivered.ok ? { ok: true } : { ok: false, error: delivered.error, detail: delivered.detail };
}

/**
 * The test print for a printer that is not saved yet (the add-printer
 * wizard's «چاپ آزمایشی»): the server renders the sample document for the
 * chosen roll width, delivery happens locally against the chosen target.
 */
export async function testPrintDraft(
  target: PrinterTarget,
  kind: "receipt" | "kitchen",
  paperWidthMm: 58 | 80,
): Promise<PrintResult> {
  let dataBase64: string;
  try {
    const res = await fetch("/api/printing/test-draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, paperWidthMm }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; dataBase64?: string };
    if (!res.ok || !data.ok || !data.dataBase64) {
      return { ok: false, error: (data.error as PrinterErrorCode) ?? "render_failed" };
    }
    dataBase64 = data.dataBase64;
  } catch {
    return { ok: false, error: "render_failed" };
  }
  const delivered = await sendRawToPrinter(target, base64ToBytes(dataBase64));
  return delivered.ok ? { ok: true } : { ok: false, error: delivered.error, detail: delivered.detail };
}

/* ────────────────────────── ready-made jobs ────────────────────────── */

export function printReceipt(printerId: string, receipt: ReceiptData): Promise<PrintResult> {
  return printJob(printerId, { type: "receipt", receipt });
}

export function printKitchenTicket(printerId: string, ticket: KitchenTicketData): Promise<PrintResult> {
  return printJob(printerId, { type: "kitchen-ticket", ticket });
}

export function testPrint(printerId: string, kind: "receipt" | "kitchen"): Promise<PrintResult> {
  return printJob(printerId, { type: "test", kind });
}

export function kickDrawer(printerId: string): Promise<PrintResult> {
  return printJob(printerId, { type: "drawer-kick" });
}

/**
 * Print one shelf label. `null` (no configured printer) is not a dead end:
 * the label opens in the browser's own print dialog, the same no-hardware
 * path documents take.
 */
export async function printLabel(printerId: string | null, label: LabelData): Promise<PrintResult> {
  if (!printerId) return printViaBrowser(renderLabelHtml(label));
  return printJob(printerId, { type: "label", label });
}

/**
 * A rendered template document (the gallery/designer preview print). Thermal
 * papers go through the saved printer; sheet papers (A4/A5 invoices) are a
 * browser-dialog job by design — they never ride the thermal connector.
 */
export async function printDocument(printerId: string | null, html: string, paper: PaperKey): Promise<PrintResult> {
  if (!printerId) return printViaBrowser(html);
  return printJob(printerId, { type: "document", html, paper });
}

/* ────────────────────────── the browser dialog ────────────────────────── */

/**
 * Open the browser's print dialog on `html`, using a hidden same-document
 * iframe rather than `window.open`: a popup is blocked by default on most
 * setups and steals focus from the POS, while an iframe prints and
 * disappears. This is the fallback/output action for A4 invoices, PDF-style
 * documents and systems with no configured hardware printer — never a saved
 * printer connection type.
 */
export function printViaBrowser(html: string): Promise<PrintResult> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve({ ok: false, error: "not_in_browser" });
      return;
    }
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.position = "fixed";
    frame.style.inset = "auto auto 0 0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    frame.style.opacity = "0";

    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      // Give the print dialog a moment to take its snapshot before the
      // document backing it goes away.
      setTimeout(() => frame.remove(), 1000);
      resolve({ ok: true });
    };

    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        if (!win) {
          frame.remove();
          resolve({ ok: false, error: "print_failed" });
          return;
        }
        win.focus();
        win.onafterprint = cleanup;
        win.print();
        // Safari/iOS never fire onafterprint; fall back to a timer.
        setTimeout(cleanup, 4000);
      } catch {
        frame.remove();
        resolve({ ok: false, error: "print_failed" });
      }
    };

    document.body.appendChild(frame);
    frame.srcdoc = html;
  });
}
