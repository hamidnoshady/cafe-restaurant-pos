"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, RefreshCwIcon, ShoppingBagIcon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import { formatModifierDelta, linePriceBreakdown } from "@/lib/modifier-display";
import { formatQueueLabel } from "@/lib/orders";
import { PAYMENT_METHOD_LABELS } from "@/lib/receipt-template";
import type { ShiftOrder, ShiftOrderLine } from "@/lib/shift-orders";
import { ModifierBadges } from "../modifier-badges";
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

/** «تخفیف» reads differently when it was a percentage — the rate is what the reviewer is checking, not just the money it came to. */
function discountLabel(order: ShiftOrder): string {
  if (order.discountType === "percent" && order.discountValue !== null) {
    return `تخفیف (${toPersianDigits(order.discountValue)}٪)`;
  }
  return "تخفیف";
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-[#8B8A85]">{label}</dt>
      <dd className="truncate text-xs font-semibold text-[#252522]">{value}</dd>
    </div>
  );
}

/** Everything about the order that isn't a line or an amount: who, where, when. */
function OrderFacts({ order }: { order: ShiftOrder }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
      <Fact label="نوع" value={TYPE_LABELS[order.type]} />
      {order.tableName ? <Fact label="میز" value={order.tableName} /> : null}
      {order.guestCount ? <Fact label="تعداد نفرات" value={toPersianDigits(order.guestCount)} /> : null}
      {order.customerName ? <Fact label="مشتری" value={order.customerName} /> : null}
      <Fact label="ساعت ثبت" value={toPersianDigits(timeLabel(order.openedAt))} />
      {order.closedAt ? <Fact label="ساعت تسویه" value={toPersianDigits(timeLabel(order.closedAt))} /> : null}
      {order.openedByName ? <Fact label="ثبت‌کننده" value={order.openedByName} /> : null}
      {order.closedByName ? <Fact label="تسویه‌کننده" value={order.closedByName} /> : null}
      {order.amendedAt ? (
        <Fact label="اصلاح‌شده" value={toPersianDigits(timeLabel(order.amendedAt))} />
      ) : null}
    </dl>
  );
}

/**
 * One line of the order, whole: what was sold, the add-ons that were rung in
 * with it and what each cost, the unit price they add up to, and any note or
 * void reason recorded against it. The add-on chips are the same
 * `ModifierBadges` the POS cart and the order dialog draw, so an add-on reads
 * identically wherever it is shown.
 */
function LineRow({ line }: { line: ShiftOrderLine }) {
  const breakdown = linePriceBreakdown({
    unitPrice: line.unitPrice,
    modifierDeltas: line.modifiers.map((modifier) => modifier.priceDelta),
    quantity: line.quantity,
  });

  return (
    <tr className="border-t border-[#F0EEE9] align-top">
      <td className="py-2 pe-3">
        <span className={line.voided ? "text-[#77756F] line-through" : "text-[#252522]"}>{line.name}</span>
        {line.voided ? <span className="ms-2 text-[11px] font-bold text-[#9E4437]">باطل‌شده</span> : null}
        <ModifierBadges modifiers={line.modifiers} tone="amber" className="mt-1.5" />
        <p className="mt-1 text-[11px] tabular-nums text-[#77756F]">
          {`هر واحد: ${formatToman(breakdown.base)}`}
          {breakdown.addOns !== 0
            ? ` ${formatModifierDelta(breakdown.addOns, { withUnit: false })} = ${formatToman(breakdown.unit)}`
            : ""}
        </p>
        {line.note ? <p className="mt-1 text-xs text-[#77756F]">یادداشت: {line.note}</p> : null}
        {line.voidReason ? (
          <p className="mt-1 text-xs text-[#9E4437]">دلیل ابطال: {line.voidReason}</p>
        ) : null}
      </td>
      <td className="py-2 pe-3 tabular-nums text-[#5E5B55]">×{toPersianDigits(line.quantity)}</td>
      <td className="py-2 tabular-nums text-[#5E5B55]">{formatToman(line.amount)}</td>
    </tr>
  );
}

function LineTable({ lines }: { lines: ShiftOrderLine[] }) {
  if (lines.length === 0) return null;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs text-[#77756F]">
          <th className="pb-2 pe-3 text-start font-medium">قلم</th>
          <th className="pb-2 pe-3 text-start font-medium">تعداد</th>
          <th className="pb-2 text-start font-medium">مبلغ</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <LineRow key={line.itemId} line={line} />
        ))}
      </tbody>
    </table>
  );
}

function Row({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-[#77756F]">{label}</dt>
      <dd className={`text-xs tabular-nums ${accent ? "font-bold text-[#B97905]" : "text-[#5E5B55]"}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The bill's arithmetic, in the same order and wording as the order dialog's
 * own summary — a reviewer comparing the two should never have to translate
 * between them. Zero-valued rows are dropped so a plain cash order stays two
 * lines long.
 */
function MoneySummary({ order }: { order: ShiftOrder }) {
  return (
    <dl className="space-y-1.5 rounded-xl border border-[#F0EEE9] bg-white px-3 py-2.5">
      <Row label="جمع جزء" value={formatToman(order.subtotal)} />
      {order.addOnTotal !== 0 ? (
        <Row label="از این مبلغ، افزودنی‌ها" value={formatModifierDelta(order.addOnTotal)} accent />
      ) : null}
      {order.discount > 0 ? (
        <Row label={discountLabel(order)} value={`- ${formatToman(order.discount)}`} />
      ) : null}
      {order.serviceCharge > 0 ? <Row label="هزینهٔ ارسال" value={formatToman(order.serviceCharge)} /> : null}
      {order.tax > 0 ? <Row label="مالیات" value={formatToman(order.tax)} /> : null}
      {order.tipAmount > 0 ? <Row label="انعام" value={formatToman(order.tipAmount)} /> : null}
      <div className="mt-1 flex items-center justify-between gap-3 rounded-lg border border-[#F2D097] bg-[#FFF9EE] px-2.5 py-2">
        <dt className="text-xs font-bold text-[#252522]">جمع کل</dt>
        <dd className="text-sm font-bold tabular-nums text-[#B97905]">{formatToman(order.total)}</dd>
      </div>
    </dl>
  );
}

function NotePanel({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        danger ? "border-[#E5CCC5] bg-[#FFF7F4]" : "border-[#F0EEE9] bg-white"
      }`}
    >
      <p className={`text-[11px] font-semibold ${danger ? "text-[#9E4437]" : "text-[#8B8A85]"}`}>{label}</p>
      <p className="mt-0.5 text-xs leading-6 text-[#5E5B55]">{value}</p>
    </div>
  );
}

/**
 * One order of the shift, collapsed to its header until opened and then shown
 * in full: its facts, its live lines with their add-ons, the lines that were
 * voided, the money breakdown, and how it was tendered.
 */
function OrderCard({ order }: { order: ShiftOrder }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = `shift-order-lines-${order.id}`;
  const liveLines = order.lines.filter((line) => !line.voided);
  const voidedLines = order.lines.filter((line) => line.voided);

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
        <div id={panelId} className="space-y-4 border-t border-[#F0EEE9] bg-[#FCFBF8] px-4 py-3">
          <OrderFacts order={order} />

          {order.lines.length === 0 ? (
            <p className="text-xs leading-6 text-[#77756F]">قلمی برای این سفارش ثبت نشده است.</p>
          ) : (
            <>
              <LineTable lines={liveLines} />
              {voidedLines.length > 0 ? (
                <div>
                  <p className="mb-1 text-[11px] font-bold text-[#9E4437]">
                    اقلام باطل‌شده ({toPersianDigits(voidedLines.length)} مورد)
                  </p>
                  <LineTable lines={voidedLines} />
                </div>
              ) : null}
            </>
          )}

          <MoneySummary order={order} />

          {order.payments.length > 0 ? (
            <div>
              <p className="mb-1 text-[11px] font-semibold text-[#8B8A85]">پرداخت‌ها</p>
              <ul className="space-y-1">
                {order.payments.map((payment, index) => (
                  <li
                    key={`${payment.receivedAt}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs text-[#5E5B55]"
                  >
                    <span className="min-w-0 font-semibold text-[#252522]">
                      {payment.methodName ?? PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}
                      <span className="ms-2 font-normal text-[#77756F]">
                        {toPersianDigits(timeLabel(payment.receivedAt))}
                        {payment.receivedByName ? ` · ${payment.receivedByName}` : ""}
                        {payment.reference ? ` · ${payment.reference}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-bold tabular-nums text-[#B97905]">
                      {formatToman(payment.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {order.note ? <NotePanel label="یادداشت سفارش" value={order.note} /> : null}
          {order.voidedReason ? (
            <NotePanel label="دلیل ابطال سفارش" value={order.voidedReason} danger />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * "سفارش‌های شیفت" — every order of one of the branch's recent shifts,
 * expandable to the whole bill: lines with their add-ons, the money
 * breakdown, and the tender. Defaults to the current shift, whose window
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
