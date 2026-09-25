/**
 * The browser's printing client — one hardware backend per surface.
 *
 * Two products, two ways to reach a printer, same `PrinterTarget` shape and
 * same canonical error codes either way:
 *
 *  - the browser/cloud product has no OS access of its own, so it hands the
 *    canonical bytes to the local Cafe POS Windows Print Connector on
 *    loopback — a small helper the operator installs once, which owns every
 *    printer the cashier's machine can reach (Windows queues and network TCP
 *    alike);
 *  - the DESKTOP app (Electron) already runs as a process on the same
 *    Windows machine as the printer, so it never needs that connector: the
 *    preload bridge (`window.businessSuiteDesktop.printing`, backed by
 *    `electron/native-printing.js`) talks to `winspool.drv` and raw TCP
 *    sockets directly from the app's own main process. Section 7 of the
 *    desktop audit was exactly this — the desktop build should not force an
 *    unrelated second installer next to itself.
 *
 * `desktopPrintingBridge()` is the one place that decides which backend a
 * given browser tab has available; every exported function below is written
 * against it so callers (the settings UI, the POS, labels) never branch on
 * "am I inside Electron?" themselves.
 *
 * A missing printer is `printer_not_configured`. Operational printing does not
 * open the browser print dialog.
 */
import type { KitchenTicketData } from "../kitchen-ticket-template";
import { renderLabelHtml, type LabelData } from "../label-template";
import type { PaperKey } from "../print-template";
import type { ReceiptData } from "../receipt-template";
import { CONNECTOR_PROTOCOL_VERSION, CONNECTOR_PORT } from "./connector-release";
import { classifyDeliveryError, type PrinterErrorCode } from "./errors";
import type { PrintJob } from "./render-service";
import type { PrinterTarget } from "./types";
import type { DesktopPrintingBridge } from "../desktop-bridge";
import "../desktop-bridge"; // registers the `Window.businessSuiteDesktop` global augmentation

export type { PrintJob } from "./render-service";

/** The connector protocol version this client speaks — shared with the installer and docs. */
const CONNECTOR_VERSION = CONNECTOR_PROTOCOL_VERSION;

function connectorBaseUrl(): string {
  return process.env.NEXT_PUBLIC_PRINT_CONNECTOR_URL || `http://127.0.0.1:${CONNECTOR_PORT}`;
}

/** Are we inside the desktop app, with its direct native-printing bridge available? */
function desktopPrintingBridge(): DesktopPrintingBridge | null {
  if (typeof window === "undefined") return null;
  return window.businessSuiteDesktop?.printing ?? null;
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
  // The desktop app never needs the loopback connector — its native bridge
  // is part of the app process itself, so there is nothing to "install" and
  // nothing that can be "outdated" independently of the app build itself.
  if (desktopPrintingBridge()) {
    return { ok: true, data: { ok: true, service: "cafe-pos-desktop-native", version: CONNECTOR_VERSION, platform: "windows" } };
  }
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

/** The print queues installed on this Windows machine (Printers & scanners). Desktop bridge first, connector otherwise. */
export async function listWindowsPrinters(): Promise<ConnectorResult<{ printers: WindowsPrinter[] }>> {
  const bridge = desktopPrintingBridge();
  if (bridge) {
    const result = await bridge.listWindowsPrinters();
    if (!result.ok) return { ok: false, error: (result.error as PrinterErrorCode) ?? "print_failed", detail: result.detail };
    return { ok: true, data: { printers: result.printers ?? [] } };
  }
  return callConnector<{ printers: WindowsPrinter[] }>("/printers/windows", {}, { method: "GET", timeoutMs: 20_000 });
}

export interface DiscoveredPrinter {
  ip: string;
  port: number;
  latencyMs: number;
}

/** Sweep this machine's local subnets for network printers (port 9100). Desktop bridge first, else the connector — never the app server. */
export async function discoverNetworkPrinters(): Promise<ConnectorResult<{ printers: DiscoveredPrinter[] }>> {
  const bridge = desktopPrintingBridge();
  if (bridge) {
    const result = await bridge.discoverNetworkPrinters();
    if (!result.ok) return { ok: false, error: (result.error as PrinterErrorCode) ?? "print_failed", detail: result.detail };
    return { ok: true, data: { printers: result.printers ?? [] } };
  }
  return callConnector<{ printers: DiscoveredPrinter[] }>("/printers/network/discover", {}, { timeoutMs: 60_000 });
}

/** Is this printer answering right now, as seen from the cashier's machine? Desktop bridge first, else the connector. */
export async function probePrinterTarget(
  target: PrinterTarget,
): Promise<ConnectorResult<{ reachable: boolean; detail?: string }>> {
  const bridge = desktopPrintingBridge();
  if (bridge) {
    const result = await bridge.probe(target);
    if (!result.ok) return { ok: false, error: (result.error as PrinterErrorCode) ?? "print_failed", detail: result.detail };
    const reachable = result.reachable === true;
    return {
      ok: true,
      data: { reachable, detail: result.detail },
      error: reachable ? undefined : target.type === "network" ? "network_unreachable" : "printer_offline",
    };
  }
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
  const bridge = desktopPrintingBridge();
  if (bridge) {
    const result = await bridge.sendRaw(target, bytesToBase64(bytes));
    if (!result.ok) {
      return { ok: false, error: (result.error as PrinterErrorCode) ?? classifyDeliveryError(result.detail, target), detail: result.detail };
    }
    return { ok: true };
  }
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
  printerId?: string;
  supportsDrawer?: boolean;
}

interface RenderedJob {
  target: PrinterTarget;
  dataBase64: string;
  delivery: "raw" | "page";
  printerName?: string;
  printerId?: string;
  supportsDrawer?: boolean;
}

const inflightPrints = new Map<string, Promise<PrintResult>>();

export interface PrintProgress {
  phase: "preparing" | "routing" | "sending" | "handed_off" | "failed";
  title: string;
  printerName?: string;
  message?: string;
  error?: PrinterErrorCode;
}

type ProgressListener = (state: PrintProgress | null) => void;
const progressListeners = new Set<ProgressListener>();

export function subscribePrintProgress(listener: ProgressListener): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

function reportProgress(state: PrintProgress | null): void {
  for (const listener of progressListeners) listener(state);
}

/** Deliver a page image through the Windows driver. Network raw ports are not page printers. */
export async function sendPageToPrinter(target: PrinterTarget, bytes: Uint8Array): Promise<ConnectorResult> {
  if (target.type !== "windows" || !target.systemName) {
    return { ok: false, error: "incompatible_printer" };
  }
  const bridge = desktopPrintingBridge();
  if (bridge?.sendPage) {
    const result = await bridge.sendPage(target.systemName, bytesToBase64(bytes));
    if (!result.ok) return { ok: false, error: (result.error as PrinterErrorCode) ?? "spooler_rejected", detail: result.detail };
    return { ok: true };
  }
  const result = await callConnector("/print/page", { target, dataBase64: bytesToBase64(bytes) }, { timeoutMs: 45_000 });
  if (!result.ok && result.error === "print_failed" && result.detail?.includes("not_found")) {
    return { ok: false, error: "connector_outdated", detail: result.detail };
  }
  return result.ok ? result : { ...result, error: result.error ?? "spooler_rejected" };
}

/**
 * Render a job for a saved printer on the authenticated app server and
 * deliver the canonical bytes through the local connector. The server only
 * ever receives the printer ID — it resolves the hardware target from the
 * database for the caller's branch, so a hand-edited request can neither
 * print through another branch's printer nor turn the server into an
 * arbitrary TCP client.
 */
export async function printJob(
  printerId: string | null,
  job: PrintJob,
  opts: { requestId?: string; title?: string; entityId?: string; documentType?: string } = {},
): Promise<PrintResult> {
  const key = opts.requestId;
  if (key) {
    const existing = inflightPrints.get(key);
    if (existing) return existing;
  }
  const run = executePrintJob(printerId, job, opts.title ?? "چاپ", opts);
  if (!key) return run;
  inflightPrints.set(key, run);
  try {
    return await run;
  } finally {
    inflightPrints.delete(key);
  }
}

async function executePrintJob(
  printerId: string | null,
  job: PrintJob,
  title: string,
  opts: { requestId?: string; entityId?: string; documentType?: string },
): Promise<PrintResult> {
  reportProgress({ phase: "preparing", title });
  let rendered: RenderedJob;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45_000);
    const res = await fetch("/api/printing/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        printerId: printerId || undefined,
        job,
        printRequestId: opts.requestId,
        documentType: opts.documentType ?? (job.type === "kitchen-ticket" ? "kitchen" : job.type === "document" ? "invoice" : job.type),
        entityId: opts.entityId,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      target?: PrinterTarget;
      dataBase64?: string;
      delivery?: "raw" | "page";
      printerName?: string;
      printerId?: string;
      supportsDrawer?: boolean;
    };
    if (!res.ok || !data.ok || !data.target || !data.dataBase64) {
      const error = (data.error as PrinterErrorCode) ?? "render_failed";
      reportProgress({ phase: "failed", title, error });
      return { ok: false, error, printerId: data.printerId, supportsDrawer: data.supportsDrawer };
    }
    rendered = {
      target: data.target,
      dataBase64: data.dataBase64,
      delivery: data.delivery === "page" ? "page" : "raw",
      printerName: data.printerName,
      printerId: data.printerId,
      supportsDrawer: data.supportsDrawer,
    };
  } catch {
    reportProgress({ phase: "failed", title, error: "render_failed" });
    return { ok: false, error: "render_failed" };
  }
  reportProgress({ phase: "sending", title, printerName: rendered.printerName });
  const bytes = base64ToBytes(rendered.dataBase64);
  const delivered = rendered.delivery === "page"
    ? await sendPageToPrinter(rendered.target, bytes)
    : await sendRawToPrinter(rendered.target, bytes);
  if (!delivered.ok) {
    reportProgress({ phase: "failed", title, printerName: rendered.printerName, error: delivered.error });
    return { ok: false, error: delivered.error, detail: delivered.detail };
  }
  reportProgress({ phase: "handed_off", title, printerName: rendered.printerName });
  if (opts.requestId) {
    void fetch("/api/printing/jobs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ printRequestId: opts.requestId, status: "handed_off" }),
    }).catch(() => undefined);
  }
  return { ok: true, printerId: rendered.printerId, supportsDrawer: rendered.supportsDrawer };
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

export function printReceipt(
  printerId: string | null,
  receipt: ReceiptData,
  opts: { requestId?: string; title?: string; entityId?: string; documentType?: "receipt" | "invoice" } = {},
): Promise<PrintResult> {
  return printJob(printerId, { type: "receipt", receipt }, { ...opts, title: opts.title ?? "چاپ رسید", documentType: opts.documentType ?? "receipt" });
}

export function printKitchenTicket(
  printerId: string | null,
  ticket: KitchenTicketData,
  opts: { requestId?: string; title?: string; entityId?: string } = {},
): Promise<PrintResult> {
  return printJob(printerId, { type: "kitchen-ticket", ticket }, { ...opts, title: opts.title ?? "چاپ آشپزخانه", documentType: "kitchen" });
}

export function testPrint(printerId: string, kind: "receipt" | "kitchen"): Promise<PrintResult> {
  return printJob(printerId, { type: "test", kind });
}

export function kickDrawer(printerId: string): Promise<PrintResult> {
  return printJob(printerId, { type: "drawer-kick" });
}

/** Print one shelf label. With no printer id, the server resolves the label rule. */
export async function printLabel(printerId: string | null, label: LabelData, opts: { requestId?: string; entityId?: string } = {}): Promise<PrintResult> {
  if (!printerId) return printJob(null, { type: "label", label }, { ...opts, documentType: "label", title: "چاپ برچسب" });
  return printJob(printerId, { type: "label", label }, { ...opts, documentType: "label", title: "چاپ برچسب" });
}

/** A rendered template document. Sheets go to a Windows queue; there is no browser dialog. */
export async function printDocument(printerId: string | null, html: string, paper: PaperKey): Promise<PrintResult> {
  if (!printerId) return { ok: false, error: "printer_not_configured" };
  return printJob(printerId, { type: "document", html, paper }, { title: "چاپ سند", documentType: paper === "a4" || paper === "a5" ? "invoice" : "receipt" });
}

