"use client";

import { useEffect, useState } from "react";
import { formatToman } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { api } from "../ui";

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
  lines: JournalLineRow[];
}

const SOURCE_LABELS: Record<string, string> = {
  order: "فروش سفارش",
  purchase: "خرید",
  waste: "ضایعات",
  opening: "تراز افتتاحیه",
  manual: "سند دستی",
};

export function EntriesSection({ refreshKey }: { refreshKey: number }) {
  const [entries, setEntries] = useState<JournalEntryRow[] | null>(null);

  useEffect(() => {
    api<{ entries: JournalEntryRow[] }>("/api/ledger/entries").then(({ ok, data }) => {
      if (ok) setEntries(data.entries);
    });
  }, [refreshKey]);

  if (!entries) return <p className="text-sm text-stone-400">در حال بارگذاری…</p>;

  return (
    <section className="space-y-3">
      {entries.map((e) => (
        <div key={e.id} className="rounded-2xl bg-white p-4 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-semibold">{e.memo || "—"}</span>
            <span className="text-xs text-stone-400">
              {SOURCE_LABELS[e.source_type ?? ""] ?? e.source_type} — {formatJalali(e.entry_date)}
              {e.created_by_name ? ` — ${e.created_by_name}` : ""}
            </span>
          </div>
          <table className="w-full text-sm">
            <tbody>
              {e.lines.map((l, i) => (
                <tr key={i} className="border-t border-stone-100">
                  <td className="py-1 pe-3 text-stone-500">
                    {l.account_code} {l.account_name}
                  </td>
                  <td className="py-1 pe-3 w-32">{Number(l.debit) !== 0 ? formatToman(Number(l.debit)) : ""}</td>
                  <td className="py-1 w-32">{Number(l.credit) !== 0 ? formatToman(Number(l.credit)) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {entries.length === 0 ? <p className="p-3 text-sm text-stone-400">هنوز سندی ثبت نشده است.</p> : null}
    </section>
  );
}
