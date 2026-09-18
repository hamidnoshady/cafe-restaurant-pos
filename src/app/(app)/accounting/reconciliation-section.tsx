"use client";

/**
 * «تطبیق بانکی و صندوق» — reconcile one settlement account against a statement.
 *
 * The work this screen supports: a person holds a bank statement (or has
 * counted the till), enters its closing balance, ticks the ledger lines the
 * statement also shows, and locks the period once the two agree exactly. What
 * is left unticked carries forward on its own — it is simply still unclaimed
 * next time (`reconciliation-service.ts`).
 *
 * The arithmetic is *not* restated here: `bank-reconciliation.ts` owns the sign
 * of a line and the definition of «مغایرت», and both this screen and the
 * service import it. That is what lets the running total update the instant a
 * box is ticked while still matching, to the rial, the number the server will
 * refuse to lock on.
 *
 * What a reconciliation screen owes its reader, and what this one now does:
 *
 *  - **Say which way the مغایرت points.** A bare «۱۲٬۰۰۰ تومان» does not say
 *    whether the bank is ahead or the books are. The read-out names it
 *    («کسری در دفاتر» / «اضافه در دفاتر») so the next step is obvious.
 *  - **Never lose a tick to a round-trip.** Every tick used to re-fetch the
 *    whole reconciliation, so on a slow connection the box stayed unticked and
 *    the totals lagged. Ticks are applied optimistically and rolled back with
 *    a message when the server disagrees.
 *  - **Only ever ask for one thing at a time.** «تکمیل و قفل» is disabled until
 *    the difference is zero, and says *why* it is disabled rather than sitting
 *    there greyed and mute.
 *  - **Be usable on a phone.** The table is a real table on a wide screen and
 *    real cards on a narrow one; the account switch scrolls instead of
 *    crushing three labels into a 320px row; every tap target clears 44px.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BanknoteIcon, CreditCardIcon, LandmarkIcon, LockIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, isoDateInTimeZone } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import {
  api,
  ErrorBox,
  errorMessage,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { reconciliationTotals } from "@/lib/bank-reconciliation";
import { FilterChip } from "@/app/dashboard/filters";

type AccountCode = "cash" | "bank" | "bankClearing";

/**
 * The three settlement accounts, matching `RECONCILABLE_ACCOUNTS` in
 * reconciliation-service.ts. بانک is here because a cheque clears *into the
 * bank* (Phase 30) — a business taking cheques had movements on ۱۱۱۰ and no
 * way to reconcile the account this very screen is named after.
 */
const ACCOUNTS: { code: AccountCode; label: string; hint: string; icon: typeof BanknoteIcon }[] = [
  { code: "cash", label: "صندوق (نقدی)", hint: "حساب ۱۱۰۰", icon: BanknoteIcon },
  { code: "bank", label: "بانک", hint: "حساب ۱۱۱۰ — وصول چک و انتقال بانکی", icon: LandmarkIcon },
  { code: "bankClearing", label: "کارت‌خوان (در راه)", hint: "حساب ۱۱۲۰", icon: CreditCardIcon },
];

interface ReconciliationSummary {
  id: string;
  accountCode: AccountCode;
  statementDate: string;
  statementBalance: number;
  status: "in_progress" | "completed";
  completedAt: string | null;
}

interface ReconciliationLine {
  journalLineId: string;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  debit: number;
  credit: number;
  cleared: boolean;
}

interface ReconciliationDetail extends ReconciliationSummary {
  openingBalance: number;
  clearedTotal: number;
  computedBalance: number;
  difference: number;
  lines: ReconciliationLine[];
}

/**
 * A statement date in the future is almost always a typo; the picker still allows it, this warns.
 *
 * "Today" is Tehran's calendar day, not UTC's. `toISOString()` is still the
 * previous date until 03:30 local, so between midnight and half past three the
 * warning fired on a statement dated *today* — the single most likely date for
 * someone reconciling at close of business.
 */
function isFutureDate(iso: string): boolean {
  if (!iso) return false;
  const today = isoDateInTimeZone(new Date()) ?? new Date().toISOString().slice(0, 10);
  return iso > today;
}

export function ReconciliationSection({
  busy,
  run,
}: {
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;
}) {
  const money = useMoney();
  const [accountCode, setAccountCode] = useState<AccountCode>("cash");
  const [history, setHistory] = useState<ReconciliationSummary[] | null>(null);
  const [detail, setDetail] = useState<ReconciliationDetail | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const [statementDate, setStatementDate] = useState("");
  const [statementBalance, setStatementBalance] = useState("");

  const [loadFailed, setLoadFailed] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  /** Line ids with a tick in flight — each keeps its own spot disabled, not the whole table. */
  const [pendingLines, setPendingLines] = useState<ReadonlySet<string>>(new Set());

  const activeAccount = ACCOUNTS.find((a) => a.code === accountCode)!;

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setHistory(null);
    setLoadFailed(false);
    setDetailFailed(false);
    setError("");
    api<{ reconciliations: ReconciliationSummary[] }>(
      `/api/ledger/reconciliations?accountCode=${accountCode}`,
    ).then(({ ok, data }) => {
      // A stale response from the account we just switched away from must not
      // land on top of the new one — switching quickly between the three tabs
      // used to be able to show one account's history under another's heading.
      if (cancelled) return;
      // `ledger_account_missing` is the real case here: a chart of accounts
      // without ۱۱۱۰ cannot be reconciled, and an endless skeleton never said so.
      if (ok) setHistory(data.reconciliations);
      else {
        setLoadFailed(true);
        setError(errorMessage((data as { error?: string }).error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accountCode, refreshKey]);

  const current = history?.find((r) => r.status === "in_progress") ?? null;
  const currentId = current?.id ?? null;

  useEffect(() => {
    if (!currentId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailFailed(false);
    api<ReconciliationDetail>(`/api/ledger/reconciliations/${currentId}`).then(({ ok, data }) => {
      if (cancelled) return;
      // Without this the screen sat on a skeleton for ever when the detail
      // failed — indistinguishable from a slow network, with no way to retry.
      if (ok) setDetail(data);
      else {
        setDetailFailed(true);
        setError(errorMessage((data as { error?: string }).error));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [currentId, refreshKey]);

  /**
   * The header totals, recomputed from whatever is ticked *right now*.
   *
   * The server sends its own `clearedTotal`/`difference`, but those describe
   * the last round-trip; an optimistic tick has to move the numbers with it or
   * the person is reading a stale «مغایرت» while deciding what to tick next.
   * Same function the service uses, so the two can never disagree.
   */
  const totals = useMemo(
    () =>
      detail
        ? reconciliationTotals({
            openingBalance: detail.openingBalance,
            statementBalance: detail.statementBalance,
            lines: detail.lines,
          })
        : null,
    [detail],
  );

  const clearedCount = detail?.lines.filter((l) => l.cleared).length ?? 0;

  async function startReconciliation() {
    setError("");
    if (!statementDate) return setError(errorMessage("statement_date_required"));
    let rial: number;
    try {
      rial = money.parse(statementBalance || "0");
    } catch {
      return setError(errorMessage("invalid_amount"));
    }
    const ok = await run(() =>
      api("/api/ledger/reconciliations", {
        method: "POST",
        body: JSON.stringify({ accountCode, statementDate, statementBalance: rial }),
      }),
    );
    if (ok) {
      setStatementDate("");
      setStatementBalance("");
      setRefreshKey((k) => k + 1);
    }
  }

  /**
   * Tick or untick one line.
   *
   * Applied to local state first and reverted if the server refuses, so the
   * checkbox responds to the click rather than to the network. The previous
   * version awaited a PATCH *and* a full re-fetch before the box moved, which
   * on a slow link read as a dead control — and ticking twenty lines meant
   * twenty full reloads of the table.
   */
  const toggleLine = useCallback(
    async (journalLineId: string, cleared: boolean) => {
      setError("");
      setPendingLines((prev) => new Set(prev).add(journalLineId));
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              lines: prev.lines.map((l) => (l.journalLineId === journalLineId ? { ...l, cleared } : l)),
            }
          : prev,
      );

      const { ok, data } = await api(`/api/ledger/reconciliations/${currentId}/lines`, {
        method: "PATCH",
        body: JSON.stringify({ journalLineId, cleared }),
      });

      setPendingLines((prev) => {
        const next = new Set(prev);
        next.delete(journalLineId);
        return next;
      });

      if (!ok) {
        setDetail((prev) =>
          prev
            ? {
                ...prev,
                lines: prev.lines.map((l) =>
                  l.journalLineId === journalLineId ? { ...l, cleared: !cleared } : l,
                ),
              }
            : prev,
        );
        setError(errorMessage((data as { error?: string }).error));
      }
    },
    [currentId],
  );

  async function complete() {
    if (!detail) return;
    setError("");
    const ok = await run(() =>
      api(`/api/ledger/reconciliations/${detail.id}/complete`, { method: "POST" }),
    );
    if (ok) setRefreshKey((k) => k + 1);
  }

  /**
   * Discard an in-progress reconciliation.
   *
   * Confirmed first because it throws away the ticks already made — but it
   * only ever releases claims, never ledger data, and the lines simply return
   * to the candidate pool for the next attempt.
   */
  async function discard() {
    if (!detail) return;
    if (
      !window.confirm(
        "این تطبیق ناتمام حذف شود؟ اقلام تطبیق‌شده آزاد می‌شوند و می‌توانید تطبیق را از نو شروع کنید.",
      )
    ) {
      return;
    }
    setError("");
    const ok = await run(() =>
      api(`/api/ledger/reconciliations/${detail.id}`, { method: "DELETE" }),
    );
    if (ok) {
      setStatementDate("");
      setStatementBalance("");
      setRefreshKey((k) => k + 1);
    }
  }

  const completedHistory = history?.filter((r) => r.status === "completed") ?? [];

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={cardClass}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کنترل وجوه</p>
              <h2 className="mt-1 text-base font-semibold text-foreground">تطبیق بانکی و صندوق</h2>
              <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
                مانده صورتحساب را با اقلام قابل تطبیق همان حساب مقایسه و در صورت برابری قفل کنید.
              </p>
            </div>
          </div>

          {/*
            Three labels never fit one 320px row: they used to wrap mid-word and
            the touch targets collapsed. The strip scrolls horizontally on a
            phone and lays out as three equal columns from `sm` up.
          */}
          <div
            role="group"
            aria-label="حساب قابل تطبیق"
            className="-mx-4 mt-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0"
          >
            {ACCOUNTS.map((a) => {
              const isActive = accountCode === a.code;
              const Icon = a.icon;
              return (
                <FilterChip
                  key={a.code}
                  selected={isActive}
                  title={a.hint}
                  onClick={() => setAccountCode(a.code)}
                  className="flex min-h-12 snap-start items-center justify-center gap-2 sm:shrink"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="whitespace-nowrap">{a.label}</span>
                </FilterChip>
              );
            })}
          </div>
          {/* The account's ledger code, which was only ever in a `title` — invisible on a touch screen. */}
          <p className="mt-2 text-xs text-muted-foreground">{activeAccount.hint}</p>
        </div>

        <div className="p-4 sm:p-5">
          {loadFailed ? (
            <div className="space-y-3">
              <EmptyState>
                بارگذاری تطبیق‌های این حساب ناموفق بود؛ اگر حساب موردنظر در سرفصل حساب‌ها نیست، ابتدا آن را
                بررسی کنید.
              </EmptyState>
              <div className="max-w-xs">
                <SecondaryButton onClick={() => setRefreshKey((k) => k + 1)}>تلاش دوباره</SecondaryButton>
              </div>
            </div>
          ) : !history ? (
            <LoadingSkeleton rows={3} label="در حال بارگذاری تطبیق‌های حساب" />
          ) : !current ? (
            <div className="rounded-xl border border-border/80 bg-muted/60 p-4">
              <h3 className="text-sm font-semibold text-foreground">شروع تطبیق جدید</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                تاریخ پایان صورتحساب و مانده پایانی آن را وارد کنید. اقلام ثبت‌شده تا همان تاریخ برای تطبیق
                نمایش داده می‌شوند.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ صورتحساب</span>
                  <JalaliDatePicker value={statementDate} onChange={setStatementDate} placeholder="تاریخ" />
                  {isFutureDate(statementDate) ? (
                    <span className="mt-1.5 block text-xs text-amber-700 dark:text-amber-300">
                      تاریخ انتخاب‌شده در آینده است؛ مطمئن شوید تاریخ پایان صورتحساب را وارد کرده‌اید.
                    </span>
                  ) : null}
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">
                    مانده صورتحساب ({money.unitLabel})
                  </span>
                  {/*
                    A till and a card-reader float cannot hold less than
                    nothing, so the minus key is simply not offered there; a
                    bank account can be overdrawn, so ۱۱۱۰ keeps it.
                  */}
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    allowNegative={accountCode === "bank"}
                    value={statementBalance}
                    onChange={(e) => setStatementBalance(e.target.value)}
                    placeholder="۰"
                  />
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    {accountCode === "bank"
                      ? "مانده پایانی صورتحساب، نه گردش دوره. برای حساب بدهکار، مقدار منفی وارد کنید."
                      : "مانده پایانی صورتحساب، نه گردش دوره."}
                  </span>
                </label>
              </div>
              <div className="mt-4 max-w-xs">
                <PrimaryButton onClick={startReconciliation} disabled={busy || !statementDate}>
                  {busy ? "در حال ثبت…" : "شروع تطبیق جدید"}
                </PrimaryButton>
              </div>
            </div>
          ) : detailFailed ? (
            <div className="space-y-3">
              <EmptyState>بارگذاری اقلام این تطبیق ناموفق بود.</EmptyState>
              <div className="max-w-xs">
                <SecondaryButton onClick={() => setRefreshKey((k) => k + 1)}>تلاش دوباره</SecondaryButton>
              </div>
            </div>
          ) : !detail || !totals ? (
            <LoadingSkeleton rows={4} label="در حال بارگذاری اقلام تطبیق" />
          ) : (
            <div className="space-y-4">
              {/* Which statement is being reconciled — the screen never said. */}
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge tone="active">تطبیق باز</StatusBadge>
                <span>
                  صورتحساب تا تاریخ{" "}
                  <span className="font-medium text-foreground">
                    {toPersianDigits(formatJalali(detail.statementDate))}
                  </span>
                </span>
              </div>

              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-border/80 bg-muted/60 p-3">
                  <dt className="text-xs text-muted-foreground">مانده صورتحساب</dt>
                  <dd className="mt-1 font-bold text-foreground">{money.format(detail.statementBalance)}</dd>
                </div>
                <div className="rounded-xl border border-border/80 bg-muted/60 p-3">
                  <dt className="text-xs text-muted-foreground">مانده اول دوره</dt>
                  <dd className="mt-1 font-bold text-foreground">{money.format(detail.openingBalance)}</dd>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    از آخرین تطبیق قفل‌شدهٔ این حساب
                  </p>
                </div>
                <div className="rounded-xl border border-border/80 bg-muted/60 p-3">
                  <dt className="text-xs text-muted-foreground">جمع اقلام تطبیق‌شده</dt>
                  <dd className="mt-1 font-bold text-foreground">{money.format(totals.clearedTotal)}</dd>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {toPersianDigits(clearedCount)} از {toPersianDigits(detail.lines.length)} قلم
                  </p>
                </div>
                <div
                  className={`rounded-xl border p-3 ${
            totals.difference === 0
                      ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/30 dark:bg-emerald-500/10"
                      : "border-destructive/30 bg-destructive/5"
                  }`}
                >
                  <dt className="text-xs text-muted-foreground">مغایرت</dt>
                  <dd
                    aria-live="polite"
                    className={`mt-1 font-bold ${
            totals.difference === 0
                        ? "text-emerald-700 dark:text-emerald-300"
                        : "text-destructive"
                    }`}
                  >
                    {money.format(Math.abs(totals.difference))}
                  </dd>
                  {/*
                    A signed number alone doesn't say which side is short. Naming
                    the direction is the difference between "there's a gap" and
                    "look for a deposit the books haven't recorded".
                  */}
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {totals.difference === 0
                      ? "برابر است؛ آمادهٔ قفل کردن"
                      : totals.difference > 0
                        ? "صورتحساب بیشتر از دفاتر است؛ قلم ثبت‌نشده را بررسی کنید."
                        : "دفاتر بیشتر از صورتحساب است؛ قلم وصول‌نشده را بررسی کنید."}
                  </p>
                </div>
              </dl>

              {detail.lines.length === 0 ? (
                <EmptyState>
                  تا تاریخ این صورتحساب، قلم تطبیق‌نشده‌ای برای این حساب ثبت نشده است.
                </EmptyState>
              ) : (
                <>
                  <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <caption className="sr-only">
                          اقلام قابل تطبیق {activeAccount.label} تا تاریخ{" "}
                          {toPersianDigits(formatJalali(detail.statementDate))}
                        </caption>
                        <thead className="bg-muted/60 text-muted-foreground">
                          <tr className="border-b border-border">
                            <th scope="col" className="px-4 py-3 text-start text-xs font-medium sm:text-sm">
                              تطبیق
                            </th>
                            <th scope="col" className="px-4 py-3 text-start text-xs font-medium sm:text-sm">
                              تاریخ
                            </th>
                            <th scope="col" className="px-4 py-3 text-start text-xs font-medium sm:text-sm">
                              منبع
                            </th>
                            <th scope="col" className="px-4 py-3 text-start text-xs font-medium sm:text-sm">
                              شرح
                            </th>
                            <th scope="col" className="px-4 py-3 text-start text-xs font-medium sm:text-sm">
                              بدهکار
                            </th>
                            <th scope="col" className="px-4 py-3 text-start text-xs font-medium sm:text-sm">
                              بستانکار
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.lines.map((l) => (
                            <tr
                              key={l.journalLineId}
                              className={`border-b border-border transition-colors last:border-b-0 ${
            l.cleared ? "bg-amber-50/60 dark:bg-amber-500/10" : ""
                              }`}
                            >
                              <td className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  className="size-5 accent-primary"
                                  checked={l.cleared}
                                  onChange={(e) => toggleLine(l.journalLineId, e.target.checked)}
                                  disabled={pendingLines.has(l.journalLineId)}
                                  aria-label={`تطبیق ${l.memo ?? "سند"} به تاریخ ${toPersianDigits(
                                    formatJalali(l.entryDate),
                                  )}`}
                                />
                              </td>
                              <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                                {toPersianDigits(formatJalali(l.entryDate))}
                              </td>
                              <td className="px-4 py-3 text-muted-foreground">
                                {ledgerSourceLabel(l.sourceType)}
                              </td>
                              <td className="px-4 py-3 text-foreground">{l.memo ?? "—"}</td>
                              <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground">
                                {l.debit ? money.format(l.debit) : "—"}
                              </td>
                              <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground">
                                {l.credit ? money.format(l.credit) : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="space-y-3 lg:hidden">
                    {detail.lines.map((l) => (
                      <label
                        key={l.journalLineId}
                        className={`block rounded-xl border p-4 transition-colors ${
            l.cleared
                            ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/30 dark:bg-amber-500/10"
                            : "border-border/80 bg-muted/60"
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={l.cleared}
                            onChange={(e) => toggleLine(l.journalLineId, e.target.checked)}
                            disabled={pendingLines.has(l.journalLineId)}
                            className="mt-1 size-5 shrink-0 accent-primary"
                            aria-label={`تطبیق ${l.memo ?? "سند"} به تاریخ ${toPersianDigits(
                              formatJalali(l.entryDate),
                            )}`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap justify-between gap-2">
                              <h3 className="text-sm font-semibold text-foreground">{l.memo ?? "—"}</h3>
                              <span className="text-xs text-muted-foreground">
                                {toPersianDigits(formatJalali(l.entryDate))}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {ledgerSourceLabel(l.sourceType)}
                            </p>
                            <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                              <div>
                                <dt className="text-xs text-muted-foreground">بدهکار</dt>
                                <dd className="mt-1 font-semibold text-foreground">
                                  {l.debit ? money.format(l.debit) : "—"}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-xs text-muted-foreground">بستانکار</dt>
                                <dd className="mt-1 font-semibold text-foreground">
                                  {l.credit ? money.format(l.credit) : "—"}
                                </dd>
                              </div>
                            </dl>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              )}

              <div className="flex flex-col gap-2 border-t border-border/80 pt-4 sm:flex-row sm:items-center">
                <div className="max-w-xs sm:w-64">
                  <PrimaryButton onClick={complete} disabled={busy || totals.difference !== 0}>
                    {busy ? "در حال قفل کردن…" : "تکمیل و قفل کردن تطبیق"}
                  </PrimaryButton>
                </div>
                {/*
                  A disabled button that never says why is a dead end; this is the
                  one sentence that turns it into an instruction.
                */}
                <p className="text-xs leading-5 text-muted-foreground">
                  {totals.difference === 0
                    ? "پس از قفل شدن، اقلام تطبیق‌شده قابل تغییر نخواهند بود."
                    : "تا زمانی که مغایرت صفر نشود، امکان قفل کردن وجود ندارد."}
                </p>
                {/*
                  The way out of a typo. A statement balance cannot be edited and
                  only one reconciliation may be open per account, so without this
                  a mistyped closing balance wedged the account for good.
                */}
                <div className="sm:ms-auto">
                  <SecondaryButton onClick={discard} disabled={busy}>
                    انصراف و حذف این تطبیق
                  </SecondaryButton>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {completedHistory.length > 0 ? (
        <div className={cardClass}>
          <header className="border-b border-border/80 px-4 py-4 sm:px-5">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">تاریخچه تطبیق‌ها</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              تطبیق‌های قفل‌شدهٔ {activeAccount.label}؛ اقلام آن‌ها دیگر قابل تغییر نیستند.
            </p>
          </header>
          <div className="p-4 sm:p-5">
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border/80 text-sm">
              {completedHistory.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="flex min-w-0 items-center gap-2 text-foreground">
                    <LockIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                    {toPersianDigits(formatJalali(r.statementDate))}
                  </span>
                  <span className="font-bold text-foreground">{money.format(r.statementBalance)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
