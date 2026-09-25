/**
 * Printer routing, purpose compatibility, drawer policy and job states.
 * Pure: callers pass the branch's printers and rules; nothing here reads
 * the database or talks to hardware.
 */
import type { DocType, PaperKey } from "../print-template";
import { isPaperKey } from "../print-template";

export type PrinterPurpose = "receipt" | "kitchen" | "label" | "document";
export type PrinterClass = "thermal" | "page" | "label";

export type PrintJobPhase = "created" | "preparing" | "routing" | "sending" | "handed_off" | "failed";

export const PRINT_PHASE_LABELS: Record<PrintJobPhase, string> = {
  created: "ایجاد درخواست چاپ",
  preparing: "آماده‌سازی سند",
  routing: "یافتن چاپگر",
  sending: "ارسال به چاپگر",
  handed_off: "به چاپگر ارسال شد",
  failed: "ارسال ناموفق",
};

export type WindowsQueueStatus =
  | "ready"
  | "available"
  | "offline"
  | "paused"
  | "error"
  | "needs_reconnection"
  | "inactive"
  | "unknown";

export const WINDOWS_STATUS_LABELS: Record<WindowsQueueStatus, string> = {
  ready: "آماده",
  available: "در ویندوز موجود است",
  offline: "خاموش",
  paused: "متوقف",
  error: "خطا",
  needs_reconnection: "نیاز به اتصال دوباره",
  inactive: "غیرفعال",
  unknown: "نامشخص",
};

/** Win32_Printer.PrinterStatus values that mean something we can say honestly. */
export function mapWindowsPrinterStatus(input: {
  printerStatus?: number | null;
  workOffline?: boolean | null;
  detectedError?: number | null;
}): WindowsQueueStatus {
  if (input.workOffline === true) return "offline";
  const code = input.printerStatus;
  if (code === 7) return "offline";
  if (code === 6) return "paused";
  if (code === 8 || (input.detectedError != null && input.detectedError > 0 && input.detectedError !== 2)) return "error";
  if (code === 3 || code === 4 || code === 5) return "ready";
  if (code == null && input.workOffline == null) return "unknown";
  return "available";
}

export interface RoutingPrinter {
  id: string;
  name: string;
  purpose: PrinterPurpose;
  printerClass: PrinterClass;
  isActive: boolean;
  isDefault: boolean;
  needsReconnect: boolean;
  supportsDrawer: boolean;
  paper?: PaperKey | null;
}

export interface PrintRuleRef {
  documentType: DocType;
  printerId: string | null;
  fallbackPrinterId: string | null;
  templateKey: string | null;
  templateId: string | null;
}

export type ResolveReason =
  | "explicit"
  | "rule"
  | "default"
  | "last_used"
  | "only"
  | "fallback"
  | "choose";

export interface ResolveResult {
  printer: RoutingPrinter | null;
  fallbackFrom: RoutingPrinter | null;
  templateKey: string | null;
  templateId: string | null;
  reason: ResolveReason;
}

const DOC_PURPOSE: Record<DocType, PrinterPurpose> = {
  receipt: "receipt",
  invoice: "document",
  kitchen: "kitchen",
  label: "label",
};

export function purposeForDocument(doc: DocType): PrinterPurpose {
  return DOC_PURPOSE[doc];
}

export function printerClassFor(purpose: PrinterPurpose, paper: PaperKey | null | undefined): PrinterClass {
  if (purpose === "label" || paper === "label57x40") return "label";
  if (paper === "a4" || paper === "a5" || purpose === "document") return "page";
  return "thermal";
}

/** A kitchen printer must not receive an invoice, and a page printer must not receive a label. */
export function printerAcceptsDocument(printer: RoutingPrinter, doc: DocType): boolean {
  if (!printer.isActive || printer.needsReconnect) return false;
  const purpose = purposeForDocument(doc);
  if (printer.purpose !== purpose) return false;
  if (doc === "label" && printer.printerClass !== "label" && printer.printerClass !== "thermal") return false;
  if (doc === "invoice" && printer.printerClass === "thermal") return false;
  if ((doc === "receipt" || doc === "kitchen") && printer.printerClass === "page") return false;
  return true;
}

export function resolvePrinter(input: {
  documentType: DocType;
  printers: RoutingPrinter[];
  rules?: PrintRuleRef[];
  requestedPrinterId?: string | null;
  lastUsedPrinterId?: string | null;
}): ResolveResult {
  const compatible = input.printers.filter((printer) => printerAcceptsDocument(printer, input.documentType));
  const rule = input.rules?.find((item) => item.documentType === input.documentType) ?? null;
  const templateKey = rule?.templateKey ?? null;
  const templateId = rule?.templateId ?? null;

  const byId = (id: string | null | undefined) => compatible.find((printer) => printer.id === id) ?? null;

  if (input.requestedPrinterId) {
    const explicit = byId(input.requestedPrinterId);
    if (explicit) return { printer: explicit, fallbackFrom: null, templateKey, templateId, reason: "explicit" };
  }

  const primary = byId(rule?.printerId);
  if (primary) return { printer: primary, fallbackFrom: null, templateKey, templateId, reason: "rule" };

  const fallback = byId(rule?.fallbackPrinterId);
  if (rule?.printerId && fallback) {
    const named = input.printers.find((printer) => printer.id === rule.printerId) ?? null;
    return { printer: fallback, fallbackFrom: named, templateKey, templateId, reason: "fallback" };
  }

  const defaults = compatible.filter((printer) => printer.isDefault);
  if (defaults.length === 1) return { printer: defaults[0], fallbackFrom: null, templateKey, templateId, reason: "default" };

  const last = byId(input.lastUsedPrinterId);
  if (last) return { printer: last, fallbackFrom: null, templateKey, templateId, reason: "last_used" };

  if (compatible.length === 1) return { printer: compatible[0], fallbackFrom: null, templateKey, templateId, reason: "only" };

  return { printer: null, fallbackFrom: null, templateKey, templateId, reason: "choose" };
}

/**
 * The drawer opens once, for a cash settlement, on a printer that has a
 * drawer. A reprint and a card payment do not pulse it.
 */
export function shouldOpenDrawer(input: {
  paymentIncludesCash: boolean;
  isReprint: boolean;
  supportsDrawer: boolean;
}): boolean {
  return input.paymentIncludesCash && !input.isReprint && input.supportsDrawer;
}

export function isSheetPaper(paper: string | null | undefined): boolean {
  return paper === "a4" || paper === "a5";
}

export function paperOfPrinter(raw: { paper?: unknown; paperWidthMm?: unknown }): PaperKey {
  if (isPaperKey(raw.paper)) return raw.paper;
  return raw.paperWidthMm === 58 ? "thermal58" : "thermal80";
}
