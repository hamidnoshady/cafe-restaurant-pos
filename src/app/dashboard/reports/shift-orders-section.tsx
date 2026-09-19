"use client";

import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, RefreshCwIcon, ShoppingBagIcon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { formatModifierDelta, linePriceBreakdown } from "@/lib/modifier-display";
import { formatQueueLabel } from "@/lib/orders";
import { PAYMENT_METHOD_LABELS } from "@/lib/receipt-template";
import type { ShiftOrder, ShiftOrderLine } from "@/lib/shift-orders";
import { ModifierBadges } from "../modifier-badges";
import { Button } from "@/components/ui/button";
import { api, inputClass } from "../ui";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";

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
  // Include the date when a shift crosses midnight; showing only the end time
  // made a 23:00–01:00 shift look like it ended before it started.
  const end = shift.endedAt
    ? toPersianDigits(formatJalali(shift.endedAt, { withMonthName: true, withTime: true }))
    : "در حال انجام";
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
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs font-semibold text-foreground">{value}</dd>
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
  const money = useMoney();
  const breakdown = linePriceBreakdown({
    unitPrice: line.unitPrice,
    modifierDeltas: line.modifiers.map((modifier) => modifier.priceDelta),
    quantity: line.quantity,
  });

  return (
    <DataTableRow className="align-top">
      <Td>
        <span className={line.voided ? "text-muted-foreground line-through" : "text-foreground"}>{line.name}</span>
        {line.voided ? <span className="ms-2 text-[11px] font-bold text-destructive">باطل‌شده</span> : null}
        <ModifierBadges modifiers={line.modifiers} tone="amber" className="mt-1.5" />
        <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
          {`هر واحد: ${money.format(breakdown.base)}`}
          {breakdown.addOns !== 0
            ? ` ${formatModifierDelta(breakdown.addOns, { withUnit: false, unit: money.unit })} = ${money.format(breakdown.unit)}`
            : ""}
        </p>
        {line.note ? <p className="mt-1 text-xs text-muted-foreground">یادداشت: {line.note}</p> : null}
        {line.voidReason ? (
          <p className="mt-1 text-xs text-destructive">دلیل ابطال: {line.voidReason}</p>
        ) : null}
      </Td>
      <Td numeric muted>×{toPersianDigits(line.quantity)}</Td>
      <Td numeric muted>{money.format(line.amount)}</Td>
    </DataTableRow>
  );
}

function LineTable({ lines }: { lines: ShiftOrderLine[] }) {
  if (lines.length === 0) return null;
  return (
    <DataTable
      caption="اقلام این سفارش"
      frame={false}
      className="-mx-1 px-1"
      tableClassName="min-w-[28rem]"
    >
      <DataTableHead>
        <Th>قلم</Th>
        <Th numeric>تعداد</Th>
        <Th numeric>مبلغ</Th>
      </DataTableHead>
      <DataTableBody>
        {lines.map((line) => (
          <LineRow key={line.itemId} line={line} />
        ))}
      </DataTableBody>
    </DataTable>
  );
}

function Row({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`text-xs tabular-nums ${accent ? "font-bold text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
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
  const money = useMoney();
  return (
    <dl className="space-y-1.5 rounded-xl border border-border bg-card px-3 py-2.5">
      <Row label="جمع جزء" value={money.format(order.subtotal)} />
      {order.addOnTotal !== 0 ? (
        <Row label="از این مبلغ، افزودنی‌ها" value={formatModifierDelta(order.addOnTotal, { unit: money.unit })} accent />
      ) : null}
      {order.discount > 0 ? (
        <Row label={discountLabel(order)} value={`- ${money.format(order.discount)}`} />
      ) : null}
      {order.serviceCharge > 0 ? <Row label="هزینهٔ خدمات" value={money.format(order.serviceCharge)} /> : null}
      {order.tax > 0 ? <Row label="مالیات" value={money.format(order.tax)} /> : null}
      {order.tipAmount > 0 ? <Row label="انعام" value={money.format(order.tipAmount)} /> : null}
      <div className="mt-1 flex items-center justify-between gap-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-2.5 py-2">
        <dt className="text-xs font-bold text-foreground">جمع کل</dt>
        <dd className="text-sm font-bold tabular-nums text-amber-700 dark:text-amber-300">{money.format(order.total)}</dd>
      </div>
    </dl>
  );
}

function NotePanel({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        danger ? "border-destructive/30 bg-destructive/5" : "border-border bg-card"
      }`}
    >
      <p className={`text-[11px] font-semibold ${danger ? "text-destructive" : "text-muted-foreground"}`}>{label}</p>
      <p className="mt-0.5 text-xs leading-6 text-muted-foreground">{value}</p>
    </div>
  );
}

/**
 * One order of the shift, collapsed to its header until opened and then shown
 * in full: its facts, its live lines with their add-ons, the lines that were
 * voided, the money breakdown, and how it was tendered.
 */
function OrderCard({ order }: { order: ShiftOrder }) {
  const money = useMoney();
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
        className="flex min-h-[64px] w-full items-center justify-between gap-3 px-4 py-3 text-start transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDownIcon
            className={`size-4 shrink-0 text-amber-700 dark:text-amber-300 transition-transform ${expanded ? "" : "-rotate-90"}`}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-foreground">
                {toPersianDigits(formatQueueLabel(order.type, order.orderNumber))}
              </span>
              <span className="inline-flex min-h-6 items-center rounded-lg bg-amber-100 dark:bg-amber-500/20 px-2 text-[11px] font-bold text-amber-700 dark:text-amber-300">
                {STATUS_LABELS[order.status] ?? order.status}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {TYPE_LABELS[order.type]}
              {order.tableName ? ` · ${order.tableName}` : ""}
              {` · ${timeLabel(order.openedAt)}`}
              {` · ${toPersianDigits(order.itemCount)} قلم`}
            </p>
          </div>
        </div>
        <span className="shrink-0 text-sm font-bold text-amber-700 dark:text-amber-300">{money.format(order.total)}</span>
      </button>

      {expanded ? (
        <div id={panelId} className="space-y-4 border-t border-border bg-muted px-4 py-3">
          <OrderFacts order={order} />

          {order.lines.length === 0 ? (
            <p className="text-xs leading-6 text-muted-foreground">قلمی برای این سفارش ثبت نشده است.</p>
          ) : (
            <>
              <LineTable lines={liveLines} />
              {voidedLines.length > 0 ? (
                <div>
                  <p className="mb-1 text-[11px] font-bold text-destructive">
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
              <p className="mb-1 text-[11px] font-semibold text-muted-foreground">پرداخت‌ها</p>
              <ul className="space-y-1">
                {order.payments.map((payment, index) => (
                  <li
                    key={`${payment.receivedAt}-${index}`}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
                  >
                    <span className="min-w-0 font-semibold text-foreground">
                      {payment.methodName ?? PAYMENT_METHOD_LABELS[payment.method] ?? payment.method}
                      <span className="ms-2 font-normal text-muted-foreground">
                        {toPersianDigits(timeLabel(payment.receivedAt))}
                        {payment.receivedByName ? ` · ${payment.receivedByName}` : ""}
                        {payment.reference ? ` · ${payment.reference}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 font-bold tabular-nums text-amber-700 dark:text-amber-300">
                      {money.format(payment.amount)}
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
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <SectionCard
      title="سفارش‌های شیفت"
      description={
        report
          ? `${shiftLabel(report.shift)} · ${toPersianDigits(report.orders.length)} سفارش`
          : "هر سفارش این شیفت، قلم‌به‌قلم."
      }
      actions={
        <>
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
          <Button type="button" variant="outline" onClick={() => void load(shiftId)} disabled={refreshing}>
            <RefreshCwIcon aria-hidden="true" />
            به‌روزرسانی
          </Button>
        </>
      }
      flush
    >
      {error ? (
        <p role="status" className="border-b border-border bg-amber-50 px-4 py-2 text-xs text-muted-foreground dark:bg-amber-500/15">
          {error}
        </p>
      ) : null}

      {!report ? (
        <div className="flex min-h-48 flex-col items-center justify-center p-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
            <ShoppingBagIcon className="size-5" aria-hidden="true" />
          </span>
          <p className="mt-4 text-sm font-semibold text-foreground">شیفتی برای این شعبه ثبت نشده است</p>
          <p className="mt-2 max-w-72 text-xs leading-6 text-muted-foreground">
            با شروع نخستین شیفت، سفارش‌های هر شیفت قلم‌به‌قلم در این بخش نمایش داده می‌شود.
          </p>
        </div>
      ) : report.orders.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyState>سفارش‌های ثبت‌شده از شروع این شیفت اینجا فهرست می‌شوند.</EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {report.orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
