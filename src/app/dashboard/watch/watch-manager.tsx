"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ErrorBox, errorMessage as sharedErrorMessage } from "../ui";
import { UnitsSection } from "./units-section";
import { RepairsSection } from "./repairs-section";

export type SerialStatus = "in_stock" | "reserved" | "sold" | "in_repair";
export type RepairStatus = "received" | "in_progress" | "ready" | "closed" | "cancelled";

export const SERIAL_STATUS_LABELS: Record<SerialStatus, string> = {
  in_stock: "موجود",
  reserved: "رزرو شده",
  sold: "فروخته‌شده",
  in_repair: "در تعمیر",
};

export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
  received: "پذیرش شده",
  in_progress: "در حال تعمیر",
  ready: "آماده تحویل",
  closed: "تحویل شده",
  cancelled: "لغو شده",
};

export interface WatchModel {
  id: string;
  name: string;
  sku: string | null;
}

export interface SerialUnit {
  id: string;
  itemId: string;
  itemName: string;
  serialNumber: string;
  status: SerialStatus;
  unitCost: number | null;
  warrantyMonths: number;
  soldAt: string | null;
  warrantyStart: string | null;
  warrantyEnd: string | null;
}

export interface RepairTicket {
  id: string;
  ticketNumber: number;
  serialId: string | null;
  itemDescription: string;
  reportedIssue: string | null;
  status: RepairStatus;
  underWarranty: boolean;
  laborCharge: number;
  vatPercent: number;
  closedAt: string | null;
  createdAt: string;
}

export interface RepairPart {
  id: string;
  description: string;
  quantity: string;
  unitCost: number;
  charge: number;
}

const TABS = [
  { key: "units", label: "دستگاه‌ها" },
  { key: "repairs", label: "تعمیرات" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string; message?: string } }>,
) => Promise<boolean>;

function watchErrorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    industry_mismatch: "این بخش فقط برای کسب‌وکارهای ساعت در دسترس است.",
    invalid_payment_method: "روش پرداخت نامعتبر است.",
    invalid_status: "وضعیت تیکت نامعتبر است.",
    serial_not_found: "دستگاه پیدا نشد.",
    ticket_not_found: "تیکت تعمیر پیدا نشد.",
  };
  return map[code ?? ""] ?? sharedErrorMessage(code);
}

export function WatchManager() {
  const [models, setModels] = useState<WatchModel[]>([]);
  const [units, setUnits] = useState<SerialUnit[]>([]);
  const [tickets, setTickets] = useState<RepairTicket[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("units");

  useEffect(() => setError(""), [tab]);

  const loadModels = useCallback(() => {
    api<{ items: WatchModel[] }>("/api/watch/items").then(({ ok, data }) => {
      if (ok) setModels(data.items);
    });
  }, []);
  useEffect(loadModels, [loadModels]);

  const loadUnits = useCallback(() => {
    api<{ units: SerialUnit[] }>("/api/watch/units").then(({ ok, data }) => {
      if (ok) setUnits(data.units);
    });
  }, []);
  useEffect(loadUnits, [loadUnits]);

  const loadTickets = useCallback(() => {
    api<{ tickets: RepairTicket[] }>("/api/watch/repairs").then(({ ok, data }) => {
      if (ok) setTickets(data.tickets);
    });
  }, []);
  useEffect(loadTickets, [loadTickets]);

  const run: Runner = async (fn) => {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(data.message || watchErrorMessage(data.error));
      return false;
    }
    loadModels();
    loadUnits();
    loadTickets();
    return true;
  };

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      <nav
        aria-label="بخش‌های ساعت"
        className="rounded-2xl border border-stone-200/80 bg-white p-2 shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                id={`watch-tab-${t.key}`}
                type="button"
                aria-pressed={isActive}
                aria-controls="watch-tabpanel"
                onClick={() => setTab(t.key)}
                className={`min-h-[52px] rounded-xl border px-3 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 sm:px-4 ${
                  isActive
                    ? "border-amber-200 bg-amber-100 text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)]"
                    : "border-transparent bg-transparent text-stone-600 hover:border-stone-200 hover:bg-stone-50 hover:text-stone-950"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div id="watch-tabpanel" role="region" aria-labelledby={`watch-tab-${tab}`} className="min-w-0">
        {tab === "units" ? (
          <UnitsSection models={models} units={units} busy={busy} run={run} />
        ) : null}
        {tab === "repairs" ? (
          <RepairsSection tickets={tickets} units={units} busy={busy} run={run} />
        ) : null}
      </div>
    </div>
  );
}
