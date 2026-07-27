"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman, parseToRial } from "@/lib/money";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { AccountRow, Runner } from "./ledger-manager";

interface DraftLineInput {
  accountId: string;
  side: "debit" | "credit";
  amount: string;
}

const EMPTY_LINE: DraftLineInput = { accountId: "", side: "debit", amount: "" };

interface DraftLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}
interface JournalDraft {
  id: string;
  entryDate: string | null;
  memo: string;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  lines: DraftLine[];
}

/**
 * Generic balanced multi-line journal entry — covers both "manual expense
 * entry" (two lines: debit an expense account, credit Cash/Bank) and
 * anything else not auto-generated (e.g. settling tax payable: debit Tax
 * Payable, credit Cash/Bank). Submitting only drafts it — see the review
 * queue below, since posting it for real needs someone holding
 * ledger.approve (Phase 16's draft → review → post workflow).
 */
export function ManualEntrySection({
  accounts,
  busy,
  run,
  refreshKey,
}: {
  accounts: AccountRow[];
  busy: boolean;
  run: Runner;
  refreshKey: number;
}) {
  const [memo, setMemo] = useState("");
  const [entryDate, setEntryDate] = useState("");
  const [lines, setLines] = useState<DraftLineInput[]>([{ ...EMPTY_LINE, side: "debit" }, { ...EMPTY_LINE, side: "credit" }]);
  const [drafts, setDrafts] = useState<JournalDraft[] | null>(null);
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    api<{ drafts: JournalDraft[] }>("/api/ledger/entries/drafts").then(({ ok, data }) => {
      if (ok) setDrafts(data.drafts);
    });
  }, [refreshKey]);

  function updateLine(index: number, patch: Partial<DraftLineInput>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { ...EMPTY_LINE }]);
  }
  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  let totalDebit = 0;
  let totalCredit = 0;
  for (const l of lines) {
    let rial = 0;
    try {
      rial = parseToRial(l.amount || "0", "toman");
    } catch {
      rial = 0;
    }
    if (l.side === "debit") totalDebit += rial;
    else totalCredit += rial;
  }
  const balanced = totalDebit > 0 && totalDebit === totalCredit;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!memo.trim() || !balanced) return;
    const payloadLines = lines
      .filter((l) => l.accountId && l.amount.trim())
      .map((l) => {
        let rial = 0;
        try {
          rial = parseToRial(l.amount, "toman");
        } catch {
          rial = 0;
        }
        return { accountId: l.accountId, debit: l.side === "debit" ? rial : 0, credit: l.side === "credit" ? rial : 0 };
      });
    const ok = await run(() =>
      api("/api/ledger/entries/drafts", {
        method: "POST",
        body: JSON.stringify({ memo, entryDate: entryDate || undefined, lines: payloadLines }),
      }),
    );
    if (ok) {
      setMemo("");
      setEntryDate("");
      setLines([{ ...EMPTY_LINE, side: "debit" }, { ...EMPTY_LINE, side: "credit" }]);
    }
  }

  async function approve(id: string) {
    setLocalError("");
    await run(() => api(`/api/ledger/entries/drafts/${id}/approve`, { method: "POST" }));
  }

  async function reject(id: string) {
    setLocalError("");
    const { ok, data } = await api(`/api/ledger/entries/drafts/${id}`, { method: "DELETE" });
    if (!ok) return setLocalError(errorMessage((data as { error?: string }).error));
    await run(() => Promise.resolve({ ok: true, data: {} }));
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">ثبت سند دستی (پیش‌نویس)</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          برای مثال ثبت هزینه (بدهکار حساب هزینه، بستانکار صندوق/بانک) یا تسویه مالیات بر ارزش افزوده پرداختنی (بدهکار مالیات
          پرداختنی، بستانکار صندوق/بانک). سند به‌صورت پیش‌نویس ذخیره می‌شود و تا زمانی که در فهرست زیر تأیید نشود، اثری در
          دفاتر ندارد.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="شرح سند" required />
            <div className="w-44">
              <JalaliDatePicker value={entryDate} onChange={setEntryDate} placeholder="تاریخ سند" />
            </div>
          </div>

          <div className="space-y-2">
            {lines.map((line, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-5">
                <select
                  className={`${inputClass} sm:col-span-2`}
                  value={line.accountId}
                  onChange={(e) => updateLine(i, { accountId: e.target.value })}
                >
                  <option value="">حساب…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
                <select className={inputClass} value={line.side} onChange={(e) => updateLine(i, { side: e.target.value as "debit" | "credit" })}>
                  <option value="debit">بدهکار</option>
                  <option value="credit">بستانکار</option>
                </select>
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  value={line.amount}
                  onChange={(e) => updateLine(i, { amount: e.target.value })}
                  placeholder="مبلغ (تومان)"
                />
                <SecondaryButton onClick={() => removeLine(i)} disabled={lines.length <= 2}>
                  حذف ردیف
                </SecondaryButton>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <SecondaryButton onClick={addLine}>افزودن ردیف</SecondaryButton>
            <PrimaryButton disabled={busy || !balanced || !memo.trim()}>ثبت پیش‌نویس</PrimaryButton>
            <span className={`text-xs ${balanced ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
              بدهکار: {totalDebit.toLocaleString("en-US")} ریال — بستانکار: {totalCredit.toLocaleString("en-US")} ریال
              {balanced ? " (متوازن)" : ""}
            </span>
          </div>
        </form>
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">پیش‌نویس‌های در انتظار بررسی</h2>
        {localError ? <p className="mb-3 text-sm text-destructive">{localError}</p> : null}
        {!drafts ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground">پیش‌نویسی در انتظار بررسی وجود ندارد.</p>
        ) : (
          <ul className="space-y-3">
            {drafts.map((d) => (
              <li key={d.id} className="rounded-lg border border-border p-3 text-sm">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold">{d.memo}</span>
                  <span className="text-xs text-muted-foreground">
                    {d.entryDate ? toPersianDigits(formatJalali(d.entryDate)) : "بدون تاریخ (امروز)"}
                    {d.createdByName ? ` — ${d.createdByName}` : ""}
                  </span>
                </div>
                <table className="w-full">
                  <tbody>
                    {d.lines.map((l, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="py-1 pe-3 text-muted-foreground">
                          {l.accountCode} {l.accountName}
                        </td>
                        <td className="w-32 py-1 pe-3">{l.debit ? formatToman(l.debit) : ""}</td>
                        <td className="w-32 py-1">{l.credit ? formatToman(l.credit) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 flex gap-2">
                  <PrimaryButton onClick={() => approve(d.id)} disabled={busy}>
                    تأیید و ثبت
                  </PrimaryButton>
                  <SecondaryButton onClick={() => reject(d.id)} disabled={busy}>
                    رد کردن
                  </SecondaryButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
