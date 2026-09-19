"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { UNKNOWN_CUSTOMER_KEY } from "@/lib/aging";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { DataTable, DataTableBody, DataTableFoot, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { FilterChip } from "@/app/dashboard/filters";
import { ArStatementPanel } from "./ar-statement-panel";
import { useOverlayEscape } from "./use-overlay-escape";
import { accountingCustomersHref } from "./accounting-routes";
import { cardClass, overlayPanelClass } from "@/app/dashboard/page-chrome";

interface CustomerBalance {
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  balance: number;
}

interface AgingRow {
  customerId: string;
  customerName: string;
  current: number;
  d31_60: number;
  d61_90: number;
  over90: number;
  total: number;
}

interface AgingReport {
  asOfDate: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, "customerId" | "customerName">;
}

const AGING_COLUMNS: { key: keyof Omit<AgingRow, "customerId" | "customerName">; label: string }[] = [
  { key: "current", label: "جاری (۰-۳۰ روز)" },
  { key: "d31_60", label: "۳۱-۶۰ روز" },
  { key: "d61_90", label: "۶۱-۹۰ روز" },
  { key: "over90", label: "بیش از ۹۰ روز" },
  { key: "total", label: "جمع" },
];

/**
 * «تلاش دوباره» for a failed load. A failed request is not an empty list —
 * saying «هیچ حسابی وجود ندارد» claims knowledge nobody has, and an error
 * banner alone (what this used to show) leaves the retry to a refresh.
 */
function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-6 text-center">
      <p role="alert" className="text-sm text-destructive">
        {message}
      </p>
      <div className="mt-3 flex justify-center">
        <SecondaryButton onClick={onRetry}>تلاش دوباره</SecondaryButton>
      </div>
    </div>
  );
}

/** A customer who paid ahead (advance or overpayment) has a *negative* balance; mark it, or it reads as debt. */
function CreditBadge() {
  return (
    <span className="ms-2 inline-block rounded-full bg-muted px-2.5 py-1 align-middle text-xs font-medium text-muted-foreground">
      بستانکار
    </span>
  );
}

/** The two receipt ways, as chips — one tap each, like the «دریافت و پرداخت» voucher form. */
const chipClass = (active: boolean) =>
  `min-h-[44px] rounded-xl border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40 ${
    active
      ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-950 dark:text-amber-200"
      : "border-border bg-card text-foreground  hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-foreground dark:hover:text-stone-100"
  }`;

export function ArSection() {
  const money = useMoney();
  const [customers, setCustomers] = useState<CustomerBalance[] | null>(null);
  const [customersFailed, setCustomersFailed] = useState(false);
  const [view, setView] = useState<"balances" | "aging">("balances");
  const [aging, setAging] = useState<AgingReport | null>(null);
  const [agingFailed, setAgingFailed] = useState(false);
  const [statementTarget, setStatementTarget] = useState<{ id: string; name: string } | null>(null);
  const [receiveTarget, setReceiveTarget] = useState<CustomerBalance | null>(null);
  // Bumped by a successful receipt and by either «تلاش دوباره» — one key, both
  // refetches, so a retry never leaves one of the two views stale.
  const [refreshKey, setRefreshKey] = useState(0);
  /*
   * «تا تاریخ» — the aging report's as-of date.
   *
   * `GET /api/ledger/ar/aging?asOfDate=` has always accepted one and the report
   * has always answered with the date it used, but the screen neither sent nor
   * showed it: the buckets were silently "as of today" and there was no way to
   * ask what the ageing looked like at a period end.
   */
  const [asOfDate, setAsOfDate] = useState("");

  useEffect(() => {
    let cancelled = false;
    setCustomersFailed(false);
    // A refetch keeps the list it already has (no skeleton flash between two
    // good loads), but shows the skeleton again when there is nothing to keep
    // — a retry after a failure must not flash «هیچ حسابی وجود ندارد» while
    // the request is still running.
    setCustomers((prev) => (prev && prev.length > 0 ? prev : null));
    api<{ customers: CustomerBalance[] }>("/api/ledger/ar/customers").then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) setCustomers(data.customers);
      // Not `null` for ever: an unending skeleton claims the request is still
      // running. An empty list would claim there are no debts — say it failed.
      else {
        setCustomers([]);
        setCustomersFailed(true);
      }
    })
    // `api()` *rejects* on a dead network (no HTTP status to read): without a
    // catch that is an unhandled rejection and the same endless skeleton.
    .catch(() => {
      if (cancelled) return;
      setCustomers([]);
      setCustomersFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (view !== "aging") return;
    let cancelled = false;
    setAging(null);
    setAgingFailed(false);
    api<AgingReport>(`/api/ledger/ar/aging${asOfDate ? `?asOfDate=${asOfDate}` : ""}`).then(({ ok, data }) => {
      if (cancelled) return;
      if (ok) setAging(data);
      // Not an empty report: an aging fetch that fails used to fall into the
      // «هیچ حساب دریافتنی بازی وجود ندارد» branch — a false claim — next to
      // an error banner that no later success ever cleared.
      else setAgingFailed(true);
    })
    .catch(() => {
      if (!cancelled) setAgingFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [view, asOfDate, refreshKey]);

  if (!customers) {
    return <SectionCardSkeleton rows={4} />;
  }

  return (
    <section className="space-y-4">
      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مطالبات مشتریان</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">حساب‌های دریافتنی</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              مانده حساب‌ها و نمای سنی بدهی مشتریان، بر پایه ثبت‌های فعلی.
            </p>
          </div>
          <div className="flex min-w-full flex-col items-stretch gap-2 sm:min-w-0 sm:items-end">
            <Link
              href={accountingCustomersHref()}
              className="inline-flex min-h-10 items-center justify-center rounded-lg border border-border px-3 text-xs font-semibold text-primary transition-colors hover:bg-muted/60 dark:hover:bg-stone-800/40"
            >
              مشتریان در حسابداری
            </Link>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="نمای حساب‌های دریافتنی">
              <FilterChip selected={view === "balances"} onClick={() => setView("balances")} className="min-h-12 w-full">مانده حساب‌ها</FilterChip>
              <FilterChip selected={view === "aging"} onClick={() => setView("aging")} className="min-h-12 w-full">نمای سنی بدهی‌ها</FilterChip>
            </div>
          </div>
        </div>

        <div className="p-4 sm:p-5">
        {view === "balances" ? (
          <div>
            {customersFailed ? (
              <LoadFailed message="بارگذاری مانده‌های دریافتنی ناموفق بود." onRetry={() => setRefreshKey((k) => k + 1)} />
            ) : customers.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">هیچ حساب دریافتنی بازی وجود ندارد.</p>
            ) : (
              <>
                <DataTable caption="مانده حساب‌های دریافتنی به تفکیک مشتری" className="hidden lg:block">
                  <DataTableHead>
                    <Th>مشتری</Th>
                    <Th>تلفن</Th>
                    <Th numeric>مانده</Th>
                    <Th>اقدام</Th>
                  </DataTableHead>
                  <DataTableBody>
                    {customers.map((c) => (
                      <DataTableRow key={c.customerId}>
                        <Td><button type="button" onClick={() => setStatementTarget({ id: c.customerId, name: c.customerName })} className="font-semibold text-foreground hover:text-amber-700 hover:underline dark:hover:text-amber-300">{c.customerName}</button></Td>
                        <Td muted>{c.customerPhone ? toPersianDigits(c.customerPhone) : "—"}</Td>
                        <Td numeric nowrap className="font-bold">{money.format(c.balance)}{c.balance < 0 ? <CreditBadge /> : null}</Td>
                        <Td>{c.customerId !== UNKNOWN_CUSTOMER_KEY ? <button type="button" onClick={() => setReceiveTarget(c)} className="inline-flex min-h-9 items-center justify-center rounded-lg px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-500/20">دریافت وجه</button> : null}</Td>
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                </DataTable>
                <div className="space-y-3 lg:hidden">
                  {customers.map((c) => (
                    <article key={c.customerId} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0"><button type="button" onClick={() => setStatementTarget({ id: c.customerId, name: c.customerName })} className="truncate text-right font-bold text-foreground hover:text-amber-700 dark:hover:text-amber-300">{c.customerName}</button><p className="mt-1 text-xs text-muted-foreground">{c.customerPhone ? toPersianDigits(c.customerPhone) : "شماره‌ای ثبت نشده"}</p></div>
                        <span className="whitespace-nowrap font-bold text-foreground">{money.format(c.balance)}</span>
                      </div>
                      {c.balance < 0 ? <div className="mt-2"><CreditBadge /></div> : null}
                      {c.customerId !== UNKNOWN_CUSTOMER_KEY ? <button type="button" onClick={() => setReceiveTarget(c)} className="mt-3 min-h-11 w-full rounded-lg bg-amber-100 px-4 text-sm font-semibold text-amber-950 transition-colors hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/30">دریافت وجه</button> : null}
                    </article>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div>
            <div className="mb-4 grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end">
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted-foreground">نمای سنی تا تاریخ</span>
                <JalaliDatePicker value={asOfDate} onChange={setAsOfDate} placeholder="امروز" />
              </label>
              {aging?.asOfDate ? (
                <p className="text-xs leading-6 text-muted-foreground">
                  محاسبه‌شده تا {toPersianDigits(formatJalali(aging.asOfDate))}
                </p>
              ) : null}
            </div>
            {agingFailed ? (
              <LoadFailed message="بارگذاری نمای سنی بدهی‌ها ناموفق بود." onRetry={() => setRefreshKey((k) => k + 1)} />
            ) : !aging ? (
              <LoadingSkeleton rows={3} />
            ) : aging.rows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">هیچ بدهی بازی (تا تاریخ انتخابی) وجود ندارد.</p>
            ) : (
              <>
                <DataTable caption="نمای سنی بدهی مشتریان" className="hidden lg:block">
                  <DataTableHead>
                    <Th>مشتری</Th>
                    {AGING_COLUMNS.map((col) => <Th key={col.key} numeric>{col.label}</Th>)}
                  </DataTableHead>
                  <DataTableBody>
                    {aging.rows.map((r) => (
                      <DataTableRow key={r.customerId}>
                        <Td><button type="button" onClick={() => setStatementTarget({ id: r.customerId, name: r.customerName })} className="font-medium text-foreground hover:text-amber-700 hover:underline dark:hover:text-amber-300">{r.customerName}</button></Td>
                        {AGING_COLUMNS.map((col) => (
                          <Td key={col.key} numeric nowrap className={col.key === "total" ? "font-bold" : undefined}>{r[col.key] ? money.format(r[col.key]) : "—"}</Td>
                        ))}
                      </DataTableRow>
                    ))}
                  </DataTableBody>
                  <DataTableFoot>
                    <tr>
                      <Td>جمع کل</Td>
                      {AGING_COLUMNS.map((col) => <Td key={col.key} numeric nowrap className="font-bold">{money.format(aging.totals[col.key])}</Td>)}
                    </tr>
                  </DataTableFoot>
                </DataTable>
                <div className="space-y-3 lg:hidden">
                  {aging.rows.map((r) => (
                    <article key={r.customerId} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                      <div className="flex items-start justify-between gap-3"><button type="button" onClick={() => setStatementTarget({ id: r.customerId, name: r.customerName })} className="min-w-0 truncate text-sm font-semibold text-foreground hover:text-amber-700 dark:hover:text-amber-300">{r.customerName}</button><span className="shrink-0 whitespace-nowrap font-bold text-foreground">{money.format(r.total)}</span></div>
                      <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                        {AGING_COLUMNS.filter((col) => col.key !== "total").map((col) => <div key={col.key}><dt className="text-xs text-muted-foreground">{col.label}</dt><dd className="mt-1 font-semibold text-foreground">{r[col.key] ? money.format(r[col.key]) : "—"}</dd></div>)}
                      </dl>
                    </article>
                  ))}
                  <dl className="rounded-xl border border-border/80 bg-muted/60 p-4"><dt className="text-sm text-muted-foreground">جمع کل حساب‌های دریافتنی</dt><dd className="mt-1 text-lg font-bold text-foreground">{money.format(aging.totals.total)}</dd></dl>
                </div>
              </>
            )}
          </div>
        )}
        </div>
      </div>

      {statementTarget ? <ArStatementPanel customerId={statementTarget.id} customerName={statementTarget.name} onClose={() => setStatementTarget(null)} /> : null}

      {receiveTarget ? (
        <ReceivePaymentDialog
          customer={receiveTarget}
          onClose={() => setReceiveTarget(null)}
          onDone={() => {
            setReceiveTarget(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      ) : null}
    </section>
  );
}

function ReceivePaymentDialog({
  customer,
  onClose,
  onDone,
}: {
  customer: CustomerBalance;
  onClose: () => void;
  onDone: () => void;
}) {
  const money = useMoney();
  const [amount, setAmount] = useState(String(money.toInput(Math.max(customer.balance, 0)) || ""));
  const [method, setMethod] = useState<"cash" | "bank">("cash");
  /*
   * «تاریخ دریافت» — optional, Shamsi. The same endpoint's other dialog (the
   * «دریافت و پرداخت» voucher form) has always been able to back-date a
   * receipt; receiving from this screen silently posted *today*, and a receipt
   * taken yesterday had to be re-entered from the other screen.
   */
  const [receiptDate, setReceiptDate] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // While the POST is in flight the dialog must not be dismissed: the receipt
  // would still land, the «onDone» refresh would never run, and the list would
  // show a balance the ledger no longer has.
  const requestClose = () => {
    if (!busy) onClose();
  };
  useOverlayEscape(requestClose);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let rial: number;
    try {
      rial = money.parse(amount);
    } catch {
      setError(errorMessage("invalid_amount"));
      return;
    }
    if (rial <= 0) {
      setError(errorMessage("invalid_amount"));
      return;
    }
    setBusy(true);
    setError("");
    /*
     * The dialog posts for itself and shows the failure *here*. This used to go
     * through the workspace-level `run`, whose ErrorBox renders behind this
     * overlay's scrim — a refused receipt (a locked fiscal period, a missing
     * ledger account) left a busy-looking dialog and an error nobody could see.
     */
    let result: { ok: boolean; data: { error?: string } };
    try {
      result = await api("/api/ledger/ar/receipts", {
        method: "POST",
        body: JSON.stringify({
          customerId: customer.customerId,
          amount: rial,
          method,
          receiptDate: receiptDate || undefined,
          memo: memo.trim() || undefined,
        }),
      });
    } catch {
      setBusy(false);
      setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
      return;
    }
    setBusy(false);
    if (!result.ok) {
      setError(errorMessage(result.data.error));
      return;
    }
    onDone();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={requestClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="receive-payment-heading"
        className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={submit}>
          <header className="mb-4 border-b border-border pb-4">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت دریافت</p>
            <h3 id="receive-payment-heading" className="mt-1 text-lg font-bold">دریافت وجه از {customer.customerName}</h3>
            {/* The number this receipt is measured against; the pre-filled
                amount already references it, so keep it on screen after the
                user edits the field. */}
            <p className="mt-1 text-sm text-muted-foreground">مانده فعلی: <span className="font-semibold text-foreground">{money.format(customer.balance)}</span></p>
          </header>
          <ErrorBox>{error}</ErrorBox>
          <Field label={`مبلغ (${money.unitLabel})`}>
            <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="۰" />
          </Field>
          <div>
            <p className="mb-1 text-sm font-medium text-foreground">روش دریافت</p>
            <div className="flex gap-2">
              <button type="button" aria-pressed={method === "cash"} className={chipClass(method === "cash")} onClick={() => setMethod("cash")}>نقدی</button>
              <button type="button" aria-pressed={method === "bank"} className={chipClass(method === "bank")} onClick={() => setMethod("bank")}>بانکی</button>
            </div>
          </div>
          <Field label="تاریخ دریافت (اختیاری)">
            <JalaliDatePicker value={receiptDate} onChange={setReceiptDate} placeholder="امروز" />
          </Field>
          <Field label="شرح (اختیاری)">
            <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <SecondaryButton onClick={onClose} disabled={busy}>
              انصراف
            </SecondaryButton>
            <PrimaryButton disabled={busy}>
              {busy ? "در حال ثبت…" : "ثبت دریافت"}
            </PrimaryButton>
          </div>
        </form>
      </section>
    </div>
  );
}
