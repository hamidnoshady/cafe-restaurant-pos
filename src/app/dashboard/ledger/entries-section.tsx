"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { api, SecondaryButton } from "../ui";
import type { Runner } from "./ledger-manager";
import { cardClass } from "../page-chrome";

interface JournalLineRow {
  entry_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit: string | number;
  credit: string | number;
}
interface JournalEntryRow {
  id: string;
  entry_date: string;
  memo: string | null;
  source_type: string | null;
  posted_at: string;
  created_by_name: string | null;
  reverses_entry_id: string | null;
  reversed_at: string | null;
  lines: JournalLineRow[];
}

const SOURCE_LABELS: Record<string, string> = {
  order: "فروش سفارش",
  purchase: "خرید",
  waste: "ضایعات",
  opening: "تراز افتتاحیه",
  manual: "سند دستی",
  expense: "هزینه",
  payroll_accrual: "تعهد حقوق",
  payroll_payment: "پرداخت حقوق",
};

export function EntriesSection({ refreshKey, busy, run }: { refreshKey: number; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [entries, setEntries] = useState<JournalEntryRow[] | null>(null);

  useEffect(() => {
    api<{ entries: JournalEntryRow[] }>("/api/ledger/entries").then(({ ok, data }) => {
      if (ok) setEntries(data.entries);
    });
  }, [refreshKey]);

  async function reverse(id: string) {
    await run(() => api(`/api/ledger/entries/${id}/reverse`, { method: "POST", body: JSON.stringify({}) }));
  }

  if (!entries) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <section className="space-y-4">
      <header className={`${cardClass} p-5`}>
        <p className="text-xs font-semibold text-amber-700">دفاتر مالی</p>
        <h2 className="mt-1">دفتر روزنامه</h2>
        <p className="mt-1 text-sm text-muted-foreground">اسناد خودکار و دستیِ ثبت‌شده، با امکان برگشت فقط برای اسناد دستی مجاز.</p>
      </header>

      {entries.length === 0 ? (
        <p className={`${cardClass} p-8 text-center text-sm text-muted-foreground`}>هنوز سندی ثبت نشده است.</p>
      ) : (
        <div className="space-y-3">
          {entries.map((e) => {
            const isReversal = !!e.reverses_entry_id;
            const isReversed = !!e.reversed_at;
            const canReverse = e.source_type === "manual" && !isReversal && !isReversed;
            return (
              <article key={e.id} className={`${cardClass} p-4 sm:p-5`}>
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-stone-100 pb-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base">{e.memo || "—"}</h3>
                      {isReversal ? <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">سند برگشتی</span> : null}
                      {isReversed ? <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-semibold text-stone-600">برگشت‌خورده</span> : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {SOURCE_LABELS[e.source_type ?? ""] ?? e.source_type} — {formatJalali(e.entry_date)}
                      {e.created_by_name ? ` — ${e.created_by_name}` : ""}
                    </p>
                  </div>
                  {canReverse ? (
                    <SecondaryButton onClick={() => reverse(e.id)} disabled={busy}>
                      برگشت سند
                    </SecondaryButton>
                  ) : null}
                </div>

                <div className="hidden overflow-x-auto lg:block">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="py-2 pe-3 text-start">حساب</th>
                        <th className="py-2 pe-3 text-start">بدهکار</th>
                        <th className="py-2 text-start">بستانکار</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.lines.map((l, i) => (
                        <tr key={i} className="border-b border-border last:border-b-0">
                          <td className="py-3 pe-3 text-muted-foreground">{l.account_code} {l.account_name}</td>
                          <td className="whitespace-nowrap py-3 pe-3">{Number(l.debit) !== 0 ? money.format(Number(l.debit)) : "—"}</td>
                          <td className="whitespace-nowrap py-3">{Number(l.credit) !== 0 ? money.format(Number(l.credit)) : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-2 lg:hidden">
                  {e.lines.map((l, i) => (
                    <div key={i} className="rounded-xl border border-stone-200/80 bg-stone-50 p-3">
                      <p className="text-sm font-semibold">{l.account_code} {l.account_name}</p>
                      <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                        <div><dt className="text-xs text-muted-foreground">بدهکار</dt><dd className="mt-1 font-semibold">{Number(l.debit) !== 0 ? money.format(Number(l.debit)) : "—"}</dd></div>
                        <div><dt className="text-xs text-muted-foreground">بستانکار</dt><dd className="mt-1 font-semibold">{Number(l.credit) !== 0 ? money.format(Number(l.credit)) : "—"}</dd></div>
                      </dl>
                    </div>
                  ))}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
