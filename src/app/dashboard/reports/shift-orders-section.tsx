"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, RefreshCwIcon, ShoppingBagIcon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import { formatQueueLabel } from "@/lib/orders";
import type { ShiftOrder } from "@/lib/shift-orders";
import { api, inputClass } from "../ui";

/** Mirrors shift-orders-service.ts's ShiftOrdersReport — declared here rather than imported so the client bundle never reaches a module that imports db.ts. */
interface ShiftOption {
  id: string;
  employeeName: string;
  startedAt: string;
  endedAt: string | null;
}

interface ShiftOrdersReport {
  shift: ShiftOption;
  shifts: ShiftOption[];
  orders: ShiftOrder[];
}

const STATUS_LABELS: Record<string, string> = {
  open: "باز",
  held: "نگه‌داشته",
  completed: "تکمیل‌شده",
  voided: "باطل‌شده",
};

const TYPE_LABELS: Record<ShiftOrder["type"], string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
};

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "زمان نامشخص";
  return new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

/** A picker option spans days, so unlike timeLabel it carries the Jalali date — same wording the shift history tab uses for an open shift. */
function shiftLabel(shift: ShiftOption): string {
  const start = toPersianDigits(formatJalali(shift.startedAt, { withMonthName: true, withTime: true }));
  const end = shift.endedAt ? toPersianDigits(timeLabel(shift.endedAt)) : "در حال انجام";
  return `${shift.employeeName} · ${start} تا ${end}`;
}

function OrderCard({ order }: { order: ShiftOrder }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = `shift-order-lines-${order.id}`;

  return (
    <li className="overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex min-h-[64px] w-full items-center justify-between gap-3 px-4 py-3 text-start transition-colors hover:bg-[#FCFBF8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E9A11B]/45"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDownIcon
            className={`size-4 shrink-0 text-[#9B6700] transition-transform ${expanded ? "" : "-rotate-90"}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-[#252522]">
                {toPersianDigits(formatQueueLabel(order.type, order.orderNumber))}
              </span>
              <span className="inline-flex min-h-6 items-center rounded-lg bg-[#FFF1D8] px-2 text-[11px] font-bold text-[#9B6700]">
                {STATUS_LABELS[order.status] ?? order.status}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-[#77756F]">
              {TYPE_LABELS[order.type]}
              {order.tableName ? ` · ${order.tableName}` : ""}
              {` · ${timeLabel(order.openedAt)}`}
              {` · ${toPersianDigits(order.itemCount)} قلم`}
            </p>
          </div>
        </div>
        <span className="shrink-0 text-sm font-bold text-[#B97905]">{formatToman(order.total)}</span>
      </button>

      {expanded ? (
        <div id={panelId} className="border-t border-[#F0EEE9] bg-[#FCFBF8] px-4 py-3">
          {order.lines.length === 0 ? (
            <p className="text-xs leading-6 text-[#77756F]">قلمی برای این سفارش ثبت نشده است.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-[#77756F]">
                  <th className="pb-2 pe-3 text-start font-medium">قلم</th>
                  <th className="pb-2 pe-3 text-start font-medium">تعداد</th>
                  <th className="pb-2 text-start font-medium">مبلغ</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.itemId} className="border-t border-[#F0EEE9]">
                    <td className="py-2 pe-3">
                      <span className={line.voided ? "text-[#77756F] line-through" : "text-[#252522]"}>
                        {line.name}
                      </span>
                      {line.voided ? (
                        <span className="ms-2 text-[11px] font-bold text-[#9B6700]">باطل‌شده</span>
                      ) : null}
                      {line.note ? <p className="mt-0.5 text-xs text-[#77756F]">{line.note}</p> : null}
                    </td>
                    <td className="py-2 pe-3 tabular-nums text-[#5E5B55]">×{toPersianDigits(line.quantity)}</td>
                    <td className="py-2 tabular-nums text-[#5E5B55]">{formatToman(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </li>
  );
}

/**
 * "سفارش‌های شیفت" — every order of one of the branch's recent shifts,
 * expandable to its item lines. Defaults to the current shift, whose window
 * rolls over on its own when the next one starts (see
 * shift-orders-service.ts), so there is no date range to pick here — only
 * which shift.
 */
export function ShiftOrdersSection() {
  const [report, setReport] = useState<ShiftOrdersReport | null>(null);
  const [shiftId, setShiftId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (id: string | null) => {
    setRefreshing(true);
    setError("");
    const { ok, data } = await api<{ report: ShiftOrdersReport | null }>(
      `/api/reports/shift-orders${id ? `?shiftId=${encodeURIComponent(id)}` : ""}`,
    );
    if (ok) setReport(data.report);
    else setError("گزارش سفارش‌های شیفت به‌روز نشد.");
    setLoaded(true);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void load(shiftId);
  }, [load, shiftId]);

  if (!loaded) {
    return (
      <section
        role="status"
        aria-live="polite"
        className="rounded-2xl border border-[#EAE8E2] bg-white px-5 py-8 text-sm text-[#77756F] shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        در حال بارگذاری…
      </section>
    );
  }

  return (
    <section
      aria-labelledby="shift-orders-heading"
      className="rounded-2xl border border-[#EAE8E2] bg-white shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#F0EEE9] p-4 sm:p-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#9B6700]">جزئیات قلم‌به‌قلم</p>
          <h2 id="shift-orders-heading" className="mt-1 font-bold text-[#252522]">
            سفارش‌های شیفت
          </h2>
          {report ? (
            <p className="mt-1 text-xs text-[#77756F]">
              {shiftLabel(report.shift)}
              {` · ${toPersianDigits(report.orders.length)} سفارش`}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {report && report.shifts.length > 1 ? (
            <SearchableSelect
              className={`${inputClass} w-auto max-w-full text-xs`}
              ariaLabel="انتخاب شیفت"
              value={report.shift.id}
              onChange={setShiftId}
              disabled={refreshing}
              options={report.shifts.map((option) => ({ value: option.id, label: shiftLabel(option) }))}
            />
          ) : null}
          <button
            type="button"
            onClick={() => void load(shiftId)}
            disabled={refreshing}
            className="flex min-h-11 items-center gap-2 rounded-xl border border-[#EAE8E2] bg-white px-3 text-xs font-bold text-[#5E5B55] transition-colors hover:bg-[#FCFBF8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 disabled:opacity-60"
          >
            <RefreshCwIcon className="size-4" aria-hidden="true" />
            به‌روزرسانی
          </button>
        </div>
      </header>

      {error ? (
        <p role="status" className="border-b border-[#F0EEE9] bg-[#FFF9EE] px-4 py-2 text-xs text-[#5E5B55]">
          {error}
        </p>
      ) : null}

      {!report ? (
        <div className="flex min-h-48 flex-col items-center justify-center p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF1D8] text-[#9B6700]">
            <ShoppingBagIcon className="size-5" aria-hidden="true" />
          </span>
          <p className="mt-4 text-sm font-bold text-[#252522]">شیفتی برای این شعبه ثبت نشده است</p>
          <p className="mt-2 max-w-72 text-xs leading-6 text-[#77756F]">
            با شروع نخستین شیفت، سفارش‌های هر شیفت قلم‌به‌قلم در این بخش نمایش داده می‌شود.
          </p>
        </div>
      ) : report.orders.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center p-6 text-center">
          <p className="text-sm font-bold text-[#252522]">سفارشی در این شیفت ثبت نشده است</p>
          <p className="mt-2 max-w-72 text-xs leading-6 text-[#77756F]">
            سفارش‌های ثبت‌شده از شروع این شیفت اینجا فهرست می‌شوند.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[#F0EEE9]">
          {report.orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </section>
  );
}
