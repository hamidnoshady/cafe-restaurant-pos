"use client";

/**
 * A saved printer's connection status, probed through the local connector
 * from the cashier's own machine — the only vantage point that can see the
 * printer. Probes run when the printer settings open, on an explicit
 * check/test, and after configuration changes; nothing polls continuously,
 * and a failed probe never blocks POS operation.
 */
import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/app/dashboard/page-chrome";
import { probePrinterTarget } from "@/lib/printing/client";
import { normalizeStoredConnection, printerTargetOf } from "@/lib/printing/types";
import type { PrinterRow } from "./use-printing";

export type PrinterStatus = "checking" | "connected" | "offline" | "reconnect" | "inactive";

export function usePrinterStatus(printer: PrinterRow) {
  const connection = normalizeStoredConnection(printer.connection);
  const target = printerTargetOf(connection);
  const [probing, setProbing] = useState(false);
  const [reachable, setReachable] = useState<boolean | null>(null);

  const probe = useCallback(async () => {
    if (!target) return;
    setProbing(true);
    const result = await probePrinterTarget(target);
    setProbing(false);
    setReachable(result.ok && result.data?.reachable === true);
  }, [target]);

  // Probe once per mount (i.e. once per opening of the settings panel) and
  // after the configuration changed — not on an interval, so a sleeping
  // printer is not hammered.
  const targetKey = target ? `${target.type}:${target.systemName ?? ""}:${target.ip ?? ""}:${target.port ?? ""}` : "";
  useEffect(() => {
    if (target) void probe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printer.id, targetKey]);

  const status: PrinterStatus = !printer.is_active
    ? "inactive"
    : !target
      ? "reconnect"
      : probing || reachable === null
        ? "checking"
        : reachable
          ? "connected"
          : "offline";

  return { status, target, probe, probing };
}

const STATUS_LABELS: Record<PrinterStatus, { label: string; tone: "active" | "positive" | "neutral" | "danger" }> = {
  connected: { label: "متصل", tone: "positive" },
  checking: { label: "در حال بررسی", tone: "neutral" },
  offline: { label: "آفلاین", tone: "danger" },
  reconnect: { label: "نیازمند اتصال دوباره", tone: "active" },
  inactive: { label: "غیرفعال", tone: "neutral" },
};

export function PrinterStatusBadge({ status }: { status: PrinterStatus }) {
  const { label, tone } = STATUS_LABELS[status];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
