"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { cardClass } from "@/app/dashboard/page-chrome";

type AccountCode = "cash" | "bank" | "bankClearing";

/**
 * The three settlement accounts, matching `RECONCILABLE_ACCOUNTS` in
 * reconciliation-service.ts. بانک is here because a cheque clears *into the
 * bank* (Phase 30) — a business taking cheques had movements on ۱۱۱۰ and no
 * way to reconcile the account this very screen is named after.
 */
const ACCOUNTS: { code: AccountCode; label: string; hint: string }[] = [
  { code: "cash", label: "صندوق (نقدی)", hint: "حساب ۱۱۰۰" },
  { code: "bank", label: "بانک", hint: "حساب ۱۱۱۰ — وصول چک و انتقال بانکی" },
  { code: "bankClearing", label: "کارت‌خوان (در راه)", hint: "حساب ۱۱۲۰" },
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

export function ReconciliationSection({ busy, run }: { busy: boolean; run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean> }) {
  const money = useMoney();
  const [accountCode, setAccountCode] = useState<AccountCode>("cash");
  const [history, setHistory] = useState<ReconciliationSummary[] | null>(null);
  const [detail, setDetail] = useState<ReconciliationDetail | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const [statementDate, setStatementDate] = useState("");
  const [statementBalance, setStatementBalance] = useState("");

  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setDetail(null);
    setHistory(null);
    setLoadFailed(false);
    api<{ reconciliations: ReconciliationSummary[] }>(`/api/ledger/reconciliations?accountCode=${accountCode}`).then(
      ({ ok, data }) => {
        // `ledger_account_missing` is the real case here: a chart of accounts
        // without ۱۱۱۰ cannot be reconciled, and an endless skeleton never said so.
        if (ok) setHistory(data.reconciliations);
        else setLoadFailed(true);
      },
    );
  }, [accountCode, refreshKey]);

  const current = history?.find((r) => r.status === "in_progress") ?? null;

  useEffect(() => {
    if (!current) {
      setDetail(null);
      return;
    }
    api<ReconciliationDetail>(`/api/ledger/reconciliations/${current.id}`).then(({ ok, data }) => {
      if (ok) setDetail(data);
    });
  }, [current?.id, refreshKey]);

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

  async function toggleLine(journalLineId: string, cleared: boolean) {
    if (!detail) return;
    setError("");
    const { ok, data } = await api(`/api/ledger/reconciliations/${detail.id}/lines`, {
      method: "PATCH",
      body: JSON.stringify({ journalLineId, cleared }),
    });
    if (!ok) return setError(errorMessage((data as { error?: string }).error));
    setRefreshKey((k) => k + 1);
  }

  async function complete() {
    if (!detail) return;
    setError("");
    const ok = await run(() => api(`/api/ledger/reconciliations/${detail.id}/complete`, { method: "POST" }));
    if (ok) setRefreshKey((k) => k + 1);
  }

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کنترل وجوه</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">تطبیق بانکی و صندوق</h2>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
              مانده صورتحساب را با اقلام قابل تطبیق همان حساب مقایسه و در صورت برابری قفل کنید.
            </p>
          </div>
          <div className="grid min-w-full grid-cols-3 gap-2 sm:min-w-0">
            {ACCOUNTS.map((a) => (
              <button
                key={a.code}
                type="button"
                aria-pressed={accountCode === a.code}
                title={a.hint}
                onClick={() => setAccountCode(a.code)}
                className={`min-h-12 rounded-xl border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40 ${
                  accountCode === a.code
                    ? "border-amber-200 bg-amber-100 font-semibold text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)] dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                    : "border-transparent text-muted-foreground hover:border-border hover:bg-stone-50 hover:text-foreground dark:hover:bg-stone-800/40"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-4 sm:p-5">
          {loadFailed ? (
            <div className="space-y-3">
              <ErrorBox>
                بارگذاری تطبیق‌های این حساب ناموفق بود؛ اگر حساب موردنظر در سرفصل حساب‌ها نیست، ابتدا آن را بررسی کنید.
              </ErrorBox>
              <div className="max-w-xs">
                <SecondaryButton onClick={() => setRefreshKey((k) => k + 1)}>تلاش دوباره</SecondaryButton>
              </div>
            </div>
          ) : !history ? (
            <LoadingSkeleton rows={3} />
          ) : !current ? (
            <div className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
              <h3 className="text-sm font-semibold text-foreground">شروع تطبیق جدید</h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">تاریخ صورتحساب</span>
                  <JalaliDatePicker value={statementDate} onChange={setStatementDate} placeholder="تاریخ" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-foreground">مانده صورتحساب ({money.unitLabel})</span>
                  <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={statementBalance} onChange={(e) => setStatementBalance(e.target.value)} placeholder="۰" />
                </label>
              </div>
              <div className="mt-4 max-w-xs">
                <PrimaryButton onClick={startReconciliation} disabled={busy}>شروع تطبیق جدید</PrimaryButton>
              </div>
            </div>
          ) : !detail ? (
            <LoadingSkeleton rows={3} />
          ) : (
            <div className="space-y-4">
              <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30"><dt className="text-xs text-muted-foreground">مانده صورتحساب</dt><dd className="mt-1 font-bold text-foreground">{money.format(detail.statementBalance)}</dd></div>
                <div className="rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30"><dt className="text-xs text-muted-foreground">مانده اول دوره</dt><dd className="mt-1 font-bold text-foreground">{money.format(detail.openingBalance)}</dd></div>
                <div className="rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30"><dt className="text-xs text-muted-foreground">جمع اقلام تطبیق‌شده</dt><dd className="mt-1 font-bold text-foreground">{money.format(detail.clearedTotal)}</dd></div>
                <div className="rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30"><dt className="text-xs text-muted-foreground">مغایرت</dt><dd className={`mt-1 font-bold ${detail.difference === 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}>{money.format(detail.difference)}</dd></div>
              </dl>

              {detail.lines.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
                  سندی برای تطبیق یافت نشد.
                </p>
              ) : (
                <>
                  <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400"><tr className="border-b border-border"><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">تطبیق</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">تاریخ</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">منبع</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">شرح</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">بدهکار</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">بستانکار</th></tr></thead>
                        <tbody>
                          {detail.lines.map((l) => (
                            <tr key={l.journalLineId} className="border-b border-border last:border-b-0">
                              <td className="px-4 py-3"><input type="checkbox" checked={l.cleared} onChange={(e) => toggleLine(l.journalLineId, e.target.checked)} disabled={busy} aria-label={`تطبیق ${l.memo ?? "سند"}`} /></td>
                              <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{toPersianDigits(formatJalali(l.entryDate))}</td>
                              <td className="px-4 py-3 text-muted-foreground">{ledgerSourceLabel(l.sourceType)}</td>
                              <td className="px-4 py-3 text-foreground">{l.memo ?? "—"}</td>
                              <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground">{l.debit ? money.format(l.debit) : "—"}</td>
                              <td className="whitespace-nowrap px-4 py-3 font-medium text-foreground">{l.credit ? money.format(l.credit) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div className="space-y-3 lg:hidden">
                    {detail.lines.map((l) => (
                      <label key={l.journalLineId} className="block rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                        <div className="flex items-start gap-3">
                          <input type="checkbox" checked={l.cleared} onChange={(e) => toggleLine(l.journalLineId, e.target.checked)} disabled={busy} className="mt-1 size-5" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm font-semibold text-foreground">{l.memo ?? "—"}</h3><span className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.entryDate))}</span></div>
                            <p className="mt-1 text-xs text-muted-foreground">{ledgerSourceLabel(l.sourceType)}</p>
                            <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm"><div><dt className="text-xs text-muted-foreground">بدهکار</dt><dd className="mt-1 font-semibold text-foreground">{l.debit ? money.format(l.debit) : "—"}</dd></div><div><dt className="text-xs text-muted-foreground">بستانکار</dt><dd className="mt-1 font-semibold text-foreground">{l.credit ? money.format(l.credit) : "—"}</dd></div></dl>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                </>
              )}

              <div className="max-w-xs">
                <PrimaryButton onClick={complete} disabled={busy || detail.difference !== 0}>تکمیل و قفل کردن تطبیق</PrimaryButton>
              </div>
            </div>
          )}
        </div>
      </div>

      {history && history.some((r) => r.status === "completed") ? (
        <div className={cardClass}>
          <header className="border-b border-border/80 px-4 py-4 sm:px-5">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
            <h2 className="mt-1 text-base font-semibold text-foreground">تاریخچه تطبیق‌ها</h2>
          </header>
          <div className="p-4 sm:p-5">
            <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border/80 text-sm">
              {history.filter((r) => r.status === "completed").map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <span className="text-foreground">{toPersianDigits(formatJalali(r.statementDate))}</span>
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
