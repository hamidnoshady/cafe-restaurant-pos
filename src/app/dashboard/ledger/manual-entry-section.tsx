"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
  const money = useMoney();
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
      rial = money.parse(l.amount || "0");
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
          rial = money.parse(l.amount);
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
    <div className="space-y-4">
      <section className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-4 sm:p-5">
        <p className="text-xs font-semibold text-amber-700">سند دستی</p>
        <h2 className="mt-1">ثبت سند دستی (پیش‌نویس)</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          سند ابتدا به‌صورت پیش‌نویس ذخیره می‌شود و تا تأیید در فهرست پایین، اثری در دفاتر ندارد.
        </p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">شرح سند</span>
              <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="شرح سند" required />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">تاریخ سند</span>
              <JalaliDatePicker value={entryDate} onChange={setEntryDate} placeholder="تاریخ سند" />
            </label>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm">ردیف‌های سند</h3>
              <span className="text-xs text-muted-foreground">حداقل دو ردیف لازم است</span>
            </div>
            {lines.map((line, i) => (
              <fieldset key={i} className="rounded-xl border border-stone-200/80 bg-stone-50 p-3">
                <legend className="px-1 text-xs font-semibold text-stone-500">ردیف {toPersianDigits(String(i + 1))}</legend>
                <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_9rem_minmax(0,1fr)_auto] md:items-end">
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">حساب</span>
                    <SearchableSelect
                      value={line.accountId}
                      onChange={(value) => updateLine(i, { accountId: value })}
                      options={[
                        { value: "", label: "انتخاب حساب" },
                        ...accounts.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` })),
                      ]}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">طرف</span>
                    <SearchableSelect
                      value={line.side}
                      onChange={(value) => updateLine(i, { side: value as "debit" | "credit" })}
                      options={[
                        { value: "debit", label: "بدهکار" },
                        { value: "credit", label: "بستانکار" },
                      ]}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">مبلغ ({money.unitLabel})</span>
                    <input
                      className={inputClass}
                      dir="ltr"
                      inputMode="numeric"
                      value={line.amount}
                      onChange={(e) => updateLine(i, { amount: e.target.value })}
                      placeholder="۰"
                    />
                  </label>
                  <SecondaryButton onClick={() => removeLine(i)} disabled={lines.length <= 2}>
                    حذف
                  </SecondaryButton>
                </div>
              </fieldset>
            ))}
          </div>

          <div className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">جمع بدهکار</dt>
                <dd className="mt-1 font-bold">{money.format(totalDebit)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">جمع بستانکار</dt>
                <dd className="mt-1 font-bold">{money.format(totalCredit)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">وضعیت سند</dt>
                <dd className={`mt-1 font-bold ${balanced ? "text-emerald-700" : "text-muted-foreground"}`}>
                  {balanced ? "متوازن" : "در انتظار توازن"}
                </dd>
              </div>
            </dl>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <SecondaryButton onClick={addLine}>افزودن ردیف</SecondaryButton>
            <div className="min-w-[12rem] flex-1 sm:max-w-xs">
              <PrimaryButton disabled={busy || !balanced || !memo.trim()}>ثبت پیش‌نویس</PrimaryButton>
            </div>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-amber-700">کنترل و تأیید</p>
            <h2 className="mt-1">پیش‌نویس‌های در انتظار بررسی</h2>
          </div>
        </div>
        {localError ? <p className="mb-3 text-sm text-destructive">{localError}</p> : null}
        {!drafts ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : drafts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">
            پیش‌نویسی در انتظار بررسی وجود ندارد.
          </p>
        ) : (
          <ul className="space-y-3">
            {drafts.map((d) => (
              <li key={d.id} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3>{d.memo}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {d.entryDate ? toPersianDigits(formatJalali(d.entryDate)) : "بدون تاریخ (امروز)"}
                      {d.createdByName ? ` — ${d.createdByName}` : ""}
                    </p>
                  </div>
                </div>
                <div className="mt-3 space-y-2">
                  {d.lines.map((l, i) => (
                    <div key={i} className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-t border-stone-100 pt-2 text-sm">
                      <span className="min-w-0 text-muted-foreground">{l.accountCode} {l.accountName}</span>
                      <span className="whitespace-nowrap">{l.debit ? money.format(l.debit) : "—"}</span>
                      <span className="whitespace-nowrap">{l.credit ? money.format(l.credit) : "—"}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <div className="min-w-40 flex-1 sm:max-w-xs">
                    <PrimaryButton onClick={() => approve(d.id)} disabled={busy}>تأیید و ثبت</PrimaryButton>
                  </div>
                  <SecondaryButton onClick={() => reject(d.id)} disabled={busy}>رد کردن</SecondaryButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
