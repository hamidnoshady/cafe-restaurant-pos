"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton } from "../ui";
import { JalaliDatePicker } from "../jalali-date-picker";
import { cardClass } from "../page-chrome";

type AccountCode = "cash" | "bankClearing";

const ACCOUNTS: { code: AccountCode; label: string }[] = [
  { code: "cash", label: "صندوق (نقدی)" },
  { code: "bankClearing", label: "کارت‌خوان (در راه)" },
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

const SOURCE_TYPE_LABELS: Record<string, string> = {
  order: "سفارش",
  purchase: "خرید",
  customer_return: "بازپرداخت مشتری",
  supplier_return: "برگشت به تأمین‌کننده",
  ar_receipt: "دریافت از مشتری",
  ap_payment: "پرداخت به تأمین‌کننده",
  manual: "سند دستی",
  expense: "هزینه",
  payroll_payment: "پرداخت حقوق",
};

export function ReconciliationSection({ busy, run }: { busy: boolean; run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean> }) {
  const money = useMoney();
  const [accountCode, setAccountCode] = useState<AccountCode>("cash");
  const [history, setHistory] = useState<ReconciliationSummary[] | null>(null);
  const [detail, setDetail] = useState<ReconciliationDetail | null>(null);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const [statementDate, setStatementDate] = useState("");
  const [statementBalance, setStatementBalance] = useState("");

  useEffect(() => {
    setDetail(null);
    api<{ reconciliations: ReconciliationSummary[] }>(`/api/ledger/reconciliations?accountCode=${accountCode}`).then(
      ({ ok, data }) => {
        if (ok) setHistory(data.reconciliations);
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

      <div className={`${cardClass} p-4 sm:p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">کنترل وجوه</p>
            <h2 className="mt-1">تطبیق بانکی و صندوق</h2>
            <p className="mt-1 text-sm text-muted-foreground">مانده صورتحساب را با اقلام قابل تطبیق همان حساب مقایسه و در صورت برابری قفل کنید.</p>
          </div>
          <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-0">
            {ACCOUNTS.map((a) => (
              <button
                key={a.code}
                type="button"
                aria-pressed={accountCode === a.code}
                onClick={() => setAccountCode(a.code)}
                className={`min-h-12 rounded-xl border px-3 text-sm ${
                  accountCode === a.code
                    ? "border-amber-200 dark:border-amber-500/30 bg-amber-100 dark:bg-amber-500/20 font-semibold text-amber-700 dark:text-amber-300"
                    : "border-transparent text-muted-foreground hover:border-border/80 hover:bg-muted"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {!history ? (
          <LoadingSkeleton rows={3} className="mt-5" />
        ) : !current ? (
          <div className="mt-5 rounded-xl border border-border/80 bg-muted p-4">
            <h3>شروع تطبیق جدید</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">تاریخ صورتحساب</span>
                <JalaliDatePicker value={statementDate} onChange={setStatementDate} placeholder="تاریخ" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">مانده صورتحساب ({money.unitLabel})</span>
                <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={statementBalance} onChange={(e) => setStatementBalance(e.target.value)} placeholder="۰" />
              </label>
            </div>
            <div className="mt-4 max-w-xs">
              <PrimaryButton onClick={startReconciliation} disabled={busy}>شروع تطبیق جدید</PrimaryButton>
            </div>
          </div>
        ) : !detail ? (
          <LoadingSkeleton rows={3} className="mt-5" />
        ) : (
          <div className="mt-5 space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-border/80 bg-muted p-3"><dt className="text-xs text-muted-foreground">مانده صورتحساب</dt><dd className="mt-1 font-bold">{money.format(detail.statementBalance)}</dd></div>
              <div className="rounded-xl border border-border/80 bg-muted p-3"><dt className="text-xs text-muted-foreground">مانده اول دوره</dt><dd className="mt-1 font-bold">{money.format(detail.openingBalance)}</dd></div>
              <div className="rounded-xl border border-border/80 bg-muted p-3"><dt className="text-xs text-muted-foreground">جمع اقلام تطبیق‌شده</dt><dd className="mt-1 font-bold">{money.format(detail.clearedTotal)}</dd></div>
              <div className="rounded-xl border border-border/80 bg-muted p-3"><dt className="text-xs text-muted-foreground">مغایرت</dt><dd className={`mt-1 font-bold ${detail.difference === 0 ? "text-emerald-700 dark:text-emerald-300" : "text-destructive"}`}>{money.format(detail.difference)}</dd></div>
            </dl>

            {detail.lines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border/80 bg-muted px-4 py-8 text-center text-sm text-muted-foreground">سندی برای تطبیق یافت نشد.</p>
            ) : (
              <>
                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-border"><th className="py-3 pe-3 text-start">تطبیق</th><th className="py-3 pe-3 text-start">تاریخ</th><th className="py-3 pe-3 text-start">منبع</th><th className="py-3 pe-3 text-start">شرح</th><th className="py-3 pe-3 text-start">بدهکار</th><th className="py-3 text-start">بستانکار</th></tr></thead>
                    <tbody>
                      {detail.lines.map((l) => (
                        <tr key={l.journalLineId} className="border-b border-border">
                          <td className="py-3 pe-3"><input type="checkbox" checked={l.cleared} onChange={(e) => toggleLine(l.journalLineId, e.target.checked)} disabled={busy} aria-label={`تطبیق ${l.memo ?? "سند"}`} /></td>
                          <td className="whitespace-nowrap py-3 pe-3 text-muted-foreground">{toPersianDigits(formatJalali(l.entryDate))}</td>
                          <td className="py-3 pe-3 text-muted-foreground">{(l.sourceType && SOURCE_TYPE_LABELS[l.sourceType]) ?? l.sourceType ?? "—"}</td>
                          <td className="py-3 pe-3">{l.memo ?? "—"}</td>
                          <td className="whitespace-nowrap py-3 pe-3">{l.debit ? money.format(l.debit) : "—"}</td>
                          <td className="whitespace-nowrap py-3">{l.credit ? money.format(l.credit) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-3 lg:hidden">
                  {detail.lines.map((l) => (
                    <label key={l.journalLineId} className="block rounded-xl border border-border/80 bg-muted p-4">
                      <div className="flex items-start gap-3">
                        <input type="checkbox" checked={l.cleared} onChange={(e) => toggleLine(l.journalLineId, e.target.checked)} disabled={busy} className="mt-1 size-5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm">{l.memo ?? "—"}</h3><span className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.entryDate))}</span></div>
                          <p className="mt-1 text-xs text-muted-foreground">{(l.sourceType && SOURCE_TYPE_LABELS[l.sourceType]) ?? l.sourceType ?? "—"}</p>
                          <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm"><div><dt className="text-xs text-muted-foreground">بدهکار</dt><dd className="mt-1 font-semibold">{l.debit ? money.format(l.debit) : "—"}</dd></div><div><dt className="text-xs text-muted-foreground">بستانکار</dt><dd className="mt-1 font-semibold">{l.credit ? money.format(l.credit) : "—"}</dd></div></dl>
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

      {history && history.some((r) => r.status === "completed") ? (
        <div className={`${cardClass} p-4 sm:p-5`}>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
          <h2 className="mt-1">تاریخچه تطبیق‌ها</h2>
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border text-sm">
            {history.filter((r) => r.status === "completed").map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span>{toPersianDigits(formatJalali(r.statementDate))}</span>
                <span className="font-bold">{money.format(r.statementBalance)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
