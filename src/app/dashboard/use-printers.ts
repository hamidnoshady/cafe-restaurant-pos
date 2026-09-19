"use client";

import { useEffect, useState } from "react";
import { api } from "./ui";
import type { PrinterPurpose } from "@/lib/printing/types";

/**
 * The operational printer row POS/order screens work with. Callers never see
 * hardware targets — they pass this id to the print client, and the server
 * resolves it against the caller's branch.
 */
export interface PrinterRow {
  id: string;
  name: string;
  kind: PrinterPurpose;
  isDefault: boolean;
  /** A legacy pairing the new architecture cannot use; printing through it is refused. */
  needsReconnect: boolean;
}

/** Active printers for the location, defaults first — used to pick a target for printing. */
export function usePrinters(): PrinterRow[] {
  const [printers, setPrinters] = useState<PrinterRow[]>([]);
  useEffect(() => {
    api<{ printers: PrinterRow[] }>("/api/printers").then(({ ok, data }) => {
      if (ok) setPrinters(data.printers);
    });
  }, []);
  return printers;
}

export function firstPrinter(printers: PrinterRow[], kind: "receipt" | "kitchen"): PrinterRow | null {
  return printers.find((p) => p.kind === kind && !p.needsReconnect) ?? null;
}

export interface BusinessInfo {
  name: string;
  address: string | null;
  phone: string | null;
  receiptFooter?: string | null;
}

/** Business/location name + contact info for the printed receipt header. */
export function useBusinessInfo(): BusinessInfo {
  const [info, setInfo] = useState<BusinessInfo>({ name: "", address: null, phone: null });
  useEffect(() => {
    api<BusinessInfo>("/api/business-info").then(({ ok, data }) => ok && setInfo(data));
  }, []);
  return info;
}
