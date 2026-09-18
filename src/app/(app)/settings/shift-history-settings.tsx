"use client";

import { EmptyState, LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Phase 20 Wave 5 — admin review of every employee's shift history
 * (team.manage-gated, the same permission that lets an owner/manager reset
 * someone else's PIN — reviewing or force-closing a shift is the same kind
 * of "act on this employee's own security state" action). The self-service
 * clock-in/clock-out side is the sidebar's ShiftButton (shift-panel.tsx);
 * this tab never opens or ends a shift on the employee's behalf except when
 * force-closing one they left open.
 *
 * What a reviewer is actually here to do decides the shape: find the shift
 * that is still open and close it, or find the night the drawer came up short
 * and see by how much. So open shifts are filterable and marked, the variance
 * is stated with the expected figure it was measured against rather than as a
 * bare number, and the history is paged instead of silently truncated at the
 * first two hundred rows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ClockIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { formatMoney, type MoneyUnit } from "@/lib/money";
import { useMoney } from "@/components/money/money-context";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";

interface CashSummary {
  orderCount: number;
  grossTotal: number;
  cashTotal: number;
  cardTotal: number;
  onlineTotal: number;
  creditTotal: number;
}

interface Shift {
  id: string;
  employeeName: string;
  locationName: string | null;
  openingFloat: number | null;
  closingFloat: number | null;
  startedAt: string;
  endedAt: string | null;
  cashSummary: CashSummary;
  /** Phase 20 Wave 7 — computed by the server in the same query as the shift list itself; see shift-service.ts's listShifts. */
  reconciliation: { expectedCash: number; variance: number } | null;
}

type StatusFilter = "" | "open" | "closed";

const PAGE_SIZE = 25;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "", label: "همه" },
  { value: "open", label: "باز" },
  { value: "closed", label: "بسته‌شده" },
];

/** The same chip the audit-log tab uses, so the two sibling panels filter identically. */
function filterChipClass(active: boolean): string {
  return (
    "min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors " +
    (active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
      : "border-border/80 text-muted-foreground hover:bg-muted")
  );
}

function formatMoment(iso: string): string {
  return toPersianDigits(formatJalali(iso, { withMonthName: true, withTime: true }));
}

/** A shift's end reads as a time alone when it finished on the day it started — the date above it already said which day. */
function formatEnd(shift: Shift): string {
  if (!shift.endedAt) return "در حال انجام";
  const sameDay =
    formatJalali(shift.startedAt, { withMonthName: true }) ===
    formatJalali(shift.endedAt, { withMonthName: true });
  return toPersianDigits(
    sameDay
      ? formatJalali(shift.endedAt, { withTime: true }).split(" ").pop() ?? ""
      : formatJalali(shift.endedAt, { withMonthName: true, withTime: true }),
  );
}

/** «۷ ساعت و ۲۰ دقیقه» — the figure a reviewer checking a forgotten clock-out is looking for. */
function formatDuration(shift: Shift): string {
  const end = shift.endedAt ? Date.parse(shift.endedAt) : Date.now();
  const start = Date.parse(shift.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const minutes = Math.floor((end - start) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${toPersianDigits(rest)} دقیقه`;
  if (rest === 0) return `${toPersianDigits(hours)} ساعت`;
  return `${toPersianDigits(hours)} ساعت و ${toPersianDigits(rest)} دقیقه`;
}

function formatFloat(value: number | null, unit: MoneyUnit = "toman"): string {
  return value === null ? "—" : toPersianDigits(formatMoney(value, unit));
}

function formatVariance(variance: number, unit: MoneyUnit = "toman"): string {
  const amount = toPersianDigits(formatMoney(Math.abs(variance), unit));
  if (variance === 0) return "بدون کسری/اضافه";
  return variance > 0 ? `${amount} اضافه` : `${amount} کسری`;
}

/** A fact of the shift: label above, value below — the same two-line shape the shift-orders report uses. */
function Fact({ label, value, tone }: { label: string; value: string; tone?: "warn" | "good" }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={
          "truncate text-xs font-semibold tabular-nums " +
          (tone === "warn"
            ? "text-destructive"
            : tone === "good"
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-foreground")
        }
      >
        {value}
      </dd>
    </div>
  );
}

export function ShiftHistorySettings() {
  const money = useMoney();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [status, setStatus] = useState<StatusFilter>("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [closingId, setClosingId] = useState<string | null>(null);
  const [closingAmount, setClosingAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Every fetch here ends in a setState, and this panel unmounts the moment the
  // member picks another settings section — see the same guard in
  // business-day-settings.tsx.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fetchPage = useCallback(
    async (filter: StatusFilter, offset: number) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (filter) params.set("status", filter);
      return api<{ shifts: Shift[]; hasMore?: boolean; error?: string }>(
        `/api/shifts?${params.toString()}`,
      );
    },
    [],
  );

  const load = useCallback(
    async (filter: StatusFilter) => {
      const { ok, data } = await fetchPage(filter, 0);
      if (!alive.current) return;
      if (ok) {
        setShifts(data.shifts);
        setHasMore(Boolean(data.hasMore));
        // Cleared on success: an error from a previous attempt that has since
        // succeeded must not stay on screen contradicting the list below it.
        setError("");
      } else {
        setShifts([]);
        setHasMore(false);
        setError(errorMessage(data.error));
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    setShifts(null);
    void load(status);
  }, [load, status]);

  async function loadMore() {
    if (!shifts) return;
    setLoadingMore(true);
    const { ok, data } = await fetchPage(status, shifts.length);
    if (!alive.current) return;
    setLoadingMore(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setShifts((current) => [...(current ?? []), ...data.shifts]);
    setHasMore(Boolean(data.hasMore));
  }

  function beginClose(shift: Shift) {
    setClosingId(shift.id);
    // Prefilled with the opening float plus this shift's cash sales — the
    // figure the drawer should hold if nothing is missing. A reviewer closing
    // somebody else's forgotten shift usually has no count to type, and this
    // makes "no variance" the honest default rather than a blank that records
    // no float at all.
    setClosingAmount(
      shift.openingFloat !== null
        ? String(money.toInput(shift.openingFloat + shift.cashSummary.cashTotal))
        : "",
    );
    setNotice("");
    setError("");
  }

  async function forceClose(id: string) {
    setBusy(true);
    setError("");
    setNotice("");
    let closingFloat: number | undefined;
    if (closingAmount.trim()) {
      try {
        closingFloat = money.parse(closingAmount);
      } catch {
        setBusy(false);
        setError(errorMessage("invalid_amount"));
        return;
      }
      // The API refuses a negative float with the same generic
      // «مبلغ معتبر نیست»; saying so before the round trip keeps the message
      // attached to the field the reviewer is looking at.
      if (closingFloat < 0) {
        setBusy(false);
        setError("موجودی صندوق نمی‌تواند منفی باشد.");
        return;
      }
    }
    const { ok, data } = await api<{
      error?: string;
      reconciliation?: { expectedCash: number; variance: number } | null;
    }>(`/api/shifts/${id}/close`, {
      method: "POST",
      body: JSON.stringify({ closingFloat }),
    });
    if (!alive.current) return;
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice(
      data.reconciliation
        ? `شیفت بسته شد — ${formatVariance(data.reconciliation.variance, money.unit)}.`
        : "شیفت با موفقیت بسته شد.",
    );
    setClosingId(null);
    setClosingAmount("");
    await load(status);
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملکرد پرسنل</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">شیفت‌ها</h2>
          </div>
        }
        description="تاریخچهٔ ورود/خروج کارکنان صندوق، گارسون و آشپزخانه. شیفت بازمانده (فراموش‌شده) را می‌توانید از همین‌جا ببندید."
      >
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        <div className="mb-4 flex flex-wrap gap-2">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value || "all"}
              type="button"
              onClick={() => setStatus(filter.value)}
              aria-pressed={status === filter.value}
              className={filterChipClass(status === filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {shifts === null && <LoadingSkeleton rows={3} label="در حال بارگذاری تاریخچهٔ شیفت‌ها" />}
        {shifts !== null && shifts.length === 0 && (
          <EmptyState>
            {status === "open"
              ? "هیچ شیفت بازی وجود ندارد."
              : status === "closed"
                ? "هنوز شیفت بسته‌شده‌ای ثبت نشده است."
                : "هنوز شیفتی ثبت نشده است."}
          </EmptyState>
        )}
        {shifts !== null && shifts.length > 0 && (
          <ul className="space-y-2">
            {shifts.map((shift) => {
              const open = !shift.endedAt;
              const variance = shift.reconciliation?.variance ?? null;
              return (
                <li key={shift.id} className="rounded-xl border border-input px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <span className="min-w-0 break-words">{shift.employeeName}</span>
                        {open ? (
                          <span className="inline-flex items-center gap-1 rounded-xl bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">
                            <ClockIcon aria-hidden="true" className="size-3" />
                            شیفت باز
                          </span>
                        ) : null}
                        {shift.locationName ? (
                          <span className="text-xs font-normal text-muted-foreground">
                            {shift.locationName}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 text-xs break-words text-muted-foreground">
                        {formatMoment(shift.startedAt)} تا {formatEnd(shift)}
                        {formatDuration(shift) ? ` · ${formatDuration(shift)}` : ""}
                      </p>
                    </div>
                    {open && closingId !== shift.id && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => beginClose(shift)}
                      >
                        بستن شیفت
                      </Button>
                    )}
                  </div>

                  <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
                    <Fact label="موجودی اول" value={formatFloat(shift.openingFloat, money.unit)} />
                    <Fact
                      label="موجودی آخر"
                      value={open ? "—" : formatFloat(shift.closingFloat, money.unit)}
                    />
                    <Fact
                      label="فروش نقدی"
                      value={toPersianDigits(formatMoney(shift.cashSummary.cashTotal, money.unit))}
                    />
                    <Fact
                      label="تعداد فاکتور"
                      value={toPersianDigits(shift.cashSummary.orderCount)}
                    />
                  </dl>

                  {shift.reconciliation ? (
                    <p className="mt-2 text-xs break-words text-muted-foreground">
                      تطبیق صندوق: مبلغ مورد انتظار{" "}
                      <span className="tabular-nums">
                        {toPersianDigits(formatMoney(shift.reconciliation.expectedCash, money.unit))}
                      </span>
                      {" — "}
                      <span
                        className={
                          variance === 0
                            ? "font-semibold text-emerald-700 dark:text-emerald-400"
                            : "font-semibold text-destructive"
                        }
                      >
                        {formatVariance(shift.reconciliation.variance, money.unit)}
                      </span>
                    </p>
                  ) : !open ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      تطبیق صندوق ثبت نشده است (موجودی اول یا آخر شمرده نشده).
                    </p>
                  ) : null}

                  {closingId === shift.id && (
                    <div className="mt-3 rounded-lg border border-dashed border-border p-3">
                      <label
                        className="mb-1 block text-xs font-medium"
                        htmlFor={`closing-float-${shift.id}`}
                      >
                        موجودی شمرده‌شدهٔ صندوق ({money.unitLabel}) — اختیاری
                      </label>
                      <p className="mb-2 text-[11px] text-muted-foreground">
                        اگر صندوق شمرده نشده خالی بگذارید؛ در این حالت شیفت بدون
                        تطبیق بسته می‌شود.
                      </p>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <PersianNumberInput
                          id={`closing-float-${shift.id}`}
                          className={inputClass + " tabular-nums sm:flex-1"}
                          dir="ltr"
                          inputMode="numeric"
                          allowNegative={false}
                          value={closingAmount}
                          onChange={(e) => setClosingAmount(e.target.value)}
                          placeholder="۰"
                        />
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            className="flex-1 sm:flex-none"
                            onClick={() => forceClose(shift.id)}
                            disabled={busy}
                          >
                            {busy ? "در حال ثبت…" : "تأیید و بستن"}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="flex-1 sm:flex-none"
                            disabled={busy}
                            onClick={() => {
                              setClosingId(null);
                              setClosingAmount("");
                            }}
                          >
                            انصراف
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {shifts !== null && hasMore ? (
          <div className="mt-4 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "در حال بارگذاری…" : "نمایش شیفت‌های قدیمی‌تر"}
            </Button>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
