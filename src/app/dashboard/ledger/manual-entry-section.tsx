"use client";

import { useState } from "react";
import { parseToRial } from "@/lib/money";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { AccountRow, Runner } from "./ledger-manager";

interface DraftLine {
  accountId: string;
  side: "debit" | "credit";
  amount: string;
}

const EMPTY_LINE: DraftLine = { accountId: "", side: "debit", amount: "" };

/**
 * Generic balanced multi-line journal entry — covers both "manual expense
 * entry" (two lines: debit an expense account, credit Cash/Bank) and
 * anything else not auto-generated (e.g. settling tax payable: debit Tax
 * Payable, credit Cash/Bank). See Phase 7 doc scope.
 */
export function ManualEntrySection({ accounts, busy, run }: { accounts: AccountRow[]; busy: boolean; run: Runner }) {
  const [memo, setMemo] = useState("");
  const [entryDate, setEntryDate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ ...EMPTY_LINE, side: "debit" }, { ...EMPTY_LINE, side: "credit" }]);

  function updateLine(index: number, patch: Partial<DraftLine>) {
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
      api("/api/ledger/entries", {
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

  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-3 font-semibold">ثبت سند دستی</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        برای مثال ثبت هزینه (بدهکار حساب هزینه، بستانکار صندوق/بانک) یا تسویه مالیات بر ارزش افزوده پرداختنی (بدهکار مالیات
        پرداختنی، بستانکار صندوق/بانک). سند فقط در صورت برابری مجموع بدهکار و بستانکار ثبت می‌شود.
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
          <PrimaryButton disabled={busy || !balanced || !memo.trim()}>ثبت سند</PrimaryButton>
          <span className={`text-xs ${balanced ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}`}>
            بدهکار: {totalDebit.toLocaleString("en-US")} ریال — بستانکار: {totalCredit.toLocaleString("en-US")} ریال
            {balanced ? " (متوازن)" : ""}
          </span>
        </div>
      </form>
    </section>
  );
}
