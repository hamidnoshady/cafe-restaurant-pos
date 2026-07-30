"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman, parseToRial, rialToToman } from "@/lib/money";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton } from "../ui";
import { JalaliDatePicker } from "../jalali-date-picker";

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
      rial = parseToRial(statementBalance || "0", "toman");
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

      <div className="rounded-2xl bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-[#9B6700]">کنترل وجوه</p>
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
                    ? "border-[#F0D7A8] bg-[#FFF1D8] font-semibold text-[#9B6700]"
                    : "border-transparent text-muted-foreground hover:border-[#EAE8E2] hover:bg-[#FCFBF8]"
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {!history ? (
          <p className="mt-5 text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : !current ? (
          <div className="mt-5 rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-4">
            <h3>شروع تطبیق جدید</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">تاریخ صورتحساب</span>
                <JalaliDatePicker value={statementDate} onChange={setStatementDate} placeholder="تاریخ" />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">مانده صورتحساب (تومان)</span>
                <input className={inputClass} dir="ltr" inputMode="numeric" value={statementBalance} onChange={(e) => setStatementBalance(e.target.value)} placeholder="۰" />
              </label>
            </div>
            <div className="mt-4 max-w-xs">
              <PrimaryButton onClick={startReconciliation} disabled={busy}>شروع تطبیق جدید</PrimaryButton>
            </div>
          </div>
        ) : !detail ? (
          <p className="mt-5 text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : (
          <div className="mt-5 space-y-4">
            <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-3"><dt className="text-xs text-muted-foreground">مانده صورتحساب</dt><dd className="mt-1 font-bold">{formatToman(detail.statementBalance)}</dd></div>
              <div className="rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-3"><dt className="text-xs text-muted-foreground">مانده اول دوره</dt><dd className="mt-1 font-bold">{formatToman(detail.openingBalance)}</dd></div>
              <div className="rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-3"><dt className="text-xs text-muted-foreground">جمع اقلام تطبیق‌شده</dt><dd className="mt-1 font-bold">{formatToman(detail.clearedTotal)}</dd></div>
              <div className="rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-3"><dt className="text-xs text-muted-foreground">مغایرت</dt><dd className={`mt-1 font-bold ${detail.difference === 0 ? "text-emerald-700" : "text-destructive"}`}>{formatToman(detail.difference)}</dd></div>
            </dl>

            {detail.lines.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[#DEDAD2] bg-[#FCFBF8] px-4 py-8 text-center text-sm text-muted-foreground">سندی برای تطبیق یافت نشد.</p>
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
                          <td className="whitespace-nowrap py-3 pe-3">{l.debit ? formatToman(l.debit) : "—"}</td>
                          <td className="whitespace-nowrap py-3">{l.credit ? formatToman(l.credit) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-3 lg:hidden">
                  {detail.lines.map((l) => (
                    <label key={l.journalLineId} className="block rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-4">
                      <div className="flex items-start gap-3">
                        <input type="checkbox" checked={l.cleared} onChange={(e) => toggleLine(l.journalLineId, e.target.checked)} disabled={busy} className="mt-1 size-5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap justify-between gap-2"><h3 className="text-sm">{l.memo ?? "—"}</h3><span className="text-xs text-muted-foreground">{toPersianDigits(formatJalali(l.entryDate))}</span></div>
                          <p className="mt-1 text-xs text-muted-foreground">{(l.sourceType && SOURCE_TYPE_LABELS[l.sourceType]) ?? l.sourceType ?? "—"}</p>
                          <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-[#F0EEE9] pt-3 text-sm"><div><dt className="text-xs text-muted-foreground">بدهکار</dt><dd className="mt-1 font-semibold">{l.debit ? formatToman(l.debit) : "—"}</dd></div><div><dt className="text-xs text-muted-foreground">بستانکار</dt><dd className="mt-1 font-semibold">{l.credit ? formatToman(l.credit) : "—"}</dd></div></dl>
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
        <div className="rounded-2xl bg-card p-4 shadow-sm sm:p-5">
          <p className="text-xs font-semibold text-[#9B6700]">سوابق</p>
          <h2 className="mt-1">تاریخچه تطبیق‌ها</h2>
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border text-sm">
            {history.filter((r) => r.status === "completed").map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <span>{toPersianDigits(formatJalali(r.statementDate))}</span>
                <span className="font-bold">{formatToman(r.statementBalance)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
