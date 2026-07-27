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

      <div className="rounded-2xl bg-card p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">تطبیق بانکی و صندوق</h2>
          <div className="flex gap-2">
            {ACCOUNTS.map((a) => (
              <button
                key={a.code}
                type="button"
                onClick={() => setAccountCode(a.code)}
                className={`rounded-lg px-3 py-1.5 text-sm ${accountCode === a.code ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"}`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {!history ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : !current ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">تاریخ صورتحساب</span>
              <div className="w-44">
                <JalaliDatePicker value={statementDate} onChange={setStatementDate} placeholder="تاریخ" />
              </div>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">مانده صورتحساب (تومان)</span>
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={statementBalance}
                onChange={(e) => setStatementBalance(e.target.value)}
              />
            </label>
            <PrimaryButton onClick={startReconciliation} disabled={busy}>
              شروع تطبیق جدید
            </PrimaryButton>
          </div>
        ) : !detail ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-muted-foreground">مانده صورتحساب</dt>
                <dd className="font-semibold">{formatToman(detail.statementBalance)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">مانده اول دوره</dt>
                <dd className="font-semibold">{formatToman(detail.openingBalance)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">جمع اقلام تطبیق‌شده</dt>
                <dd className="font-semibold">{formatToman(detail.clearedTotal)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">مغایرت</dt>
                <dd className={`font-semibold ${detail.difference === 0 ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>
                  {formatToman(detail.difference)}
                </dd>
              </div>
            </dl>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="py-2 pe-3 text-start">تطبیق</th>
                    <th className="py-2 pe-3 text-start">تاریخ</th>
                    <th className="py-2 pe-3 text-start">منبع</th>
                    <th className="py-2 pe-3 text-start">شرح</th>
                    <th className="py-2 pe-3 text-start">بدهکار</th>
                    <th className="py-2 text-start">بستانکار</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.lines.map((l) => (
                    <tr key={l.journalLineId} className="border-b border-border">
                      <td className="py-1.5 pe-3">
                        <input
                          type="checkbox"
                          checked={l.cleared}
                          onChange={(e) => toggleLine(l.journalLineId, e.target.checked)}
                          disabled={busy}
                        />
                      </td>
                      <td className="py-1.5 pe-3 text-muted-foreground">{toPersianDigits(formatJalali(l.entryDate))}</td>
                      <td className="py-1.5 pe-3 text-muted-foreground">
                        {(l.sourceType && SOURCE_TYPE_LABELS[l.sourceType]) ?? l.sourceType ?? "—"}
                      </td>
                      <td className="py-1.5 pe-3">{l.memo ?? "—"}</td>
                      <td className="py-1.5 pe-3 tabular-nums">{l.debit ? formatToman(l.debit) : "—"}</td>
                      <td className="py-1.5 tabular-nums">{l.credit ? formatToman(l.credit) : "—"}</td>
                    </tr>
                  ))}
                  {detail.lines.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-4 text-center text-muted-foreground">
                        سندی برای تطبیق یافت نشد.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <PrimaryButton onClick={complete} disabled={busy || detail.difference !== 0}>
              تکمیل و قفل کردن تطبیق
            </PrimaryButton>
          </div>
        )}
      </div>

      {history && history.some((r) => r.status === "completed") ? (
        <div className="rounded-2xl bg-card p-5 shadow-sm">
          <h2 className="mb-3 font-semibold">تاریخچه تطبیق‌ها</h2>
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {history
              .filter((r) => r.status === "completed")
              .map((r) => (
                <li key={r.id} className="flex items-center justify-between px-4 py-2">
                  <span>{toPersianDigits(formatJalali(r.statementDate))}</span>
                  <span className="font-semibold">{formatToman(r.statementBalance)}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
