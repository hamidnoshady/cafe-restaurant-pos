"use client";

import { useEffect, useState } from "react";
import { formatToman } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { api, SecondaryButton } from "../ui";
import type { Runner } from "./ledger-manager";

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
  const [entries, setEntries] = useState<JournalEntryRow[] | null>(null);

  useEffect(() => {
    api<{ entries: JournalEntryRow[] }>("/api/ledger/entries").then(({ ok, data }) => {
      if (ok) setEntries(data.entries);
    });
  }, [refreshKey]);

  async function reverse(id: string) {
    await run(() => api(`/api/ledger/entries/${id}/reverse`, { method: "POST", body: JSON.stringify({}) }));
  }

  if (!entries) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <section className="space-y-3">
      {entries.map((e) => {
        const isReversal = !!e.reverses_entry_id;
        const isReversed = !!e.reversed_at;
        const canReverse = e.source_type === "manual" && !isReversal && !isReversed;
        return (
          <div key={e.id} className="rounded-2xl bg-card p-4 shadow-sm">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="flex flex-wrap items-center gap-2 font-semibold">
                {e.memo || "—"}
                {isReversal ? (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-normal text-amber-700 dark:text-amber-400">
                    سند برگشتی
                  </span>
                ) : null}
                {isReversed ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                    برگشت‌خورده
                  </span>
                ) : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {SOURCE_LABELS[e.source_type ?? ""] ?? e.source_type} — {formatJalali(e.entry_date)}
                {e.created_by_name ? ` — ${e.created_by_name}` : ""}
              </span>
            </div>
            <table className="w-full text-sm">
              <tbody>
                {e.lines.map((l, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1 pe-3 text-muted-foreground">
                      {l.account_code} {l.account_name}
                    </td>
                    <td className="py-1 pe-3 w-32">{Number(l.debit) !== 0 ? formatToman(Number(l.debit)) : ""}</td>
                    <td className="py-1 w-32">{Number(l.credit) !== 0 ? formatToman(Number(l.credit)) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canReverse ? (
              <div className="mt-2">
                <SecondaryButton onClick={() => reverse(e.id)} disabled={busy}>
                  برگشت سند
                </SecondaryButton>
              </div>
            ) : null}
          </div>
        );
      })}
      {entries.length === 0 ? <p className="p-3 text-sm text-muted-foreground">هنوز سندی ثبت نشده است.</p> : null}
    </section>
  );
}
