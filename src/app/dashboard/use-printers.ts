"use client";

import { useEffect, useState } from "react";
import type { PrinterConnection } from "@/lib/printer-connection";
import { api } from "./ui";

export interface PrinterRow {
  id: string;
  name: string;
  kind: "receipt" | "kitchen";
  connection: PrinterConnection;
}

/** Active printers for the location — used to find a target for the print agent (src/lib/print-agent-client.ts). */
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
  return printers.find((p) => p.kind === kind) ?? null;
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
