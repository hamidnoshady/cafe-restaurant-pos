"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ledgerSourceLabel } from "@/lib/ledger-source-labels";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, ErrorBox, inputClass, SecondaryButton } from "@/app/dashboard/ui";
import type { Runner } from "./accounting-manager";
import { cardClass } from "@/app/dashboard/page-chrome";

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

/**
 * «دفتر روزنامه» — every posted entry, its lines, and the reversal action for
 * the manual ones.
 *
 * Two things this screen used to get wrong, both now fixed here rather than
 * papered over: it printed the raw English `source_type` for any code its own
 * eight-entry map missed (`ledgerSourceLabel` is the complete table, shared
 * with reconciliation and the reports drill-down), and it silently showed the
 * newest hundred documents with no filter and no hint that a hundred-and-first
 * existed. The filters are the API's — a Jalali date range that stores ISO, one
 * source, and a search over the memo, the poster and the accounts touched.
 */
export function EntriesSection({ refreshKey, busy, run }: { refreshKey: number; busy: boolean; run: Runner }) {
  const money = useMoney();
  const [entries, setEntries] = useState<JournalEntryRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sourceType, setSourceType] = useState("");
  const [q, setQ] = useState("");
  const [sourceTypes, setSourceTypes] = useState<string[]>([]);

  useEffect(() => {
    api<{ sourceTypes: string[] }>("/api/ledger/entries/source-types").then(({ ok, data }) => {
      if (ok) setSourceTypes(data.sourceTypes);
    });
  }, [refreshKey]);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (sourceType) params.set("sourceType", sourceType);
    if (q.trim()) params.set("q", q.trim());
    setError("");
    api<{ entries: JournalEntryRow[]; hasMore: boolean }>(`/api/ledger/entries?${params}`).then(({ ok, data }) => {
      if (ok) {
        setEntries(data.entries);
        setHasMore(!!data.hasMore);
      } else {
        setError("بارگذاری دفتر روزنامه ناموفق بود. دوباره تلاش کنید.");
      }
    });
  }, [dateFrom, dateTo, sourceType, q]);

  useEffect(() => {
    setEntries(null);
    const timer = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, q, refreshKey]);

  async function reverse(id: string) {
    await run(() => api(`/api/ledger/entries/${id}/reverse`, { method: "POST", body: JSON.stringify({}) }));
  }

  const filtered = !!(dateFrom || dateTo || sourceType || q.trim());

  return (
    <div className="space-y-4">
      <section className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دفاتر مالی</p>
          <h2 className="mt-1 text-base font-semibold text-foreground">دفتر روزنامه</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            اسناد خودکار و دستیِ ثبت‌شده، با امکان برگشت فقط برای اسناد دستی مجاز.
          </p>
        </header>

        <div className="border-b border-border/80 p-4 sm:p-5">
          <div className="grid gap-3 rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30 lg:grid-cols-4 lg:items-end">
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">از تاریخ</span>
              <JalaliDatePicker value={dateFrom} onChange={setDateFrom} placeholder="از ابتدا" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">تا تاریخ</span>
              <JalaliDatePicker value={dateTo} onChange={setDateTo} placeholder="تا امروز" />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">منبع سند</span>
              <SearchableSelect
                value={sourceType}
                onChange={setSourceType}
                ariaLabel="منبع سند"
                options={[
                  { value: "", label: "همهٔ منابع" },
                  ...sourceTypes.map((code) => ({ value: code, label: ledgerSourceLabel(code) })),
                ]}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs text-muted-foreground">جست‌وجو</span>
              <input
                className={inputClass}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="شرح، ثبت‌کننده یا نام/کد حساب…"
              />
            </label>
          </div>
          {filtered ? (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <SecondaryButton
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                  setSourceType("");
                  setQ("");
                }}
              >
                پاک کردن فیلترها
              </SecondaryButton>
              <span className="text-xs text-muted-foreground">
                {entries ? `${toPersianDigits(entries.length)} سند در این فیلتر` : ""}
              </span>
            </div>
          ) : null}
        </div>

        <div className="p-4 sm:p-5">
          <ErrorBox>{error}</ErrorBox>
          {!entries ? (
            error ? null : <SectionCardSkeleton rows={4} label="در حال بارگذاری دفتر روزنامه" />
          ) : entries.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              {filtered ? "سندی با این فیلترها پیدا نشد." : "هنوز سندی ثبت نشده است."}
            </p>
          ) : (
            <div className="space-y-3">
              {entries.map((e) => {
                const isReversal = !!e.reverses_entry_id;
                const isReversed = !!e.reversed_at;
                const canReverse = e.source_type === "manual" && !isReversal && !isReversed;
                const total = e.lines.reduce((sum, l) => sum + Number(l.debit), 0);
                return (
                  <article key={e.id} className={cardClass}>
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-4 py-4 sm:px-5">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate text-base font-semibold text-foreground">{e.memo || "سند بدون شرح"}</h3>
                          {isReversal ? (
                            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">
                              سند برگشتی
                            </span>
                          ) : null}
                          {isReversed ? (
                            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
                              برگشت‌خورده
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {ledgerSourceLabel(e.source_type)} — {toPersianDigits(formatJalali(e.entry_date))}
                          {e.created_by_name ? ` — ${e.created_by_name}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="whitespace-nowrap text-sm font-bold text-foreground">{money.format(total)}</span>
                        {canReverse ? (
                          <SecondaryButton onClick={() => reverse(e.id)} disabled={busy}>
                            برگشت سند
                          </SecondaryButton>
                        ) : null}
                      </div>
                    </div>

                    <div className="p-4 sm:p-5">
                      <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
                        <table className="w-full text-sm">
                          <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400">
                            <tr className="border-b border-border">
                              <th className="px-4 py-2.5 text-start text-xs font-medium sm:text-sm">حساب</th>
                              <th className="px-4 py-2.5 text-start text-xs font-medium sm:text-sm">بدهکار</th>
                              <th className="px-4 py-2.5 text-start text-xs font-medium sm:text-sm">بستانکار</th>
                            </tr>
                          </thead>
                          <tbody>
                            {e.lines.map((l, i) => (
                              <tr key={i} className="border-b border-border last:border-b-0">
                                <td className="px-4 py-3 text-muted-foreground">
                                  {l.account_code} {l.account_name}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums text-foreground">
                                  {Number(l.debit) !== 0 ? money.format(Number(l.debit)) : "—"}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 font-medium tabular-nums text-foreground">
                                  {Number(l.credit) !== 0 ? money.format(Number(l.credit)) : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="space-y-2 lg:hidden">
                        {e.lines.map((l, i) => (
                          <div key={i} className="rounded-xl border border-border/80 bg-stone-50/60 p-3 dark:bg-stone-800/30">
                            <p className="text-sm font-medium text-foreground">
                              {l.account_code} {l.account_name}
                            </p>
                            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm">
                              <div>
                                <dt className="text-xs text-muted-foreground">بدهکار</dt>
                                <dd className="mt-1 font-semibold tabular-nums text-foreground">
                                  {Number(l.debit) !== 0 ? money.format(Number(l.debit)) : "—"}
                                </dd>
                              </div>
                              <div>
                                <dt className="text-xs text-muted-foreground">بستانکار</dt>
                                <dd className="mt-1 font-semibold tabular-nums text-foreground">
                                  {Number(l.credit) !== 0 ? money.format(Number(l.credit)) : "—"}
                                </dd>
                              </div>
                            </dl>
                          </div>
                        ))}
                      </div>
                    </div>
                  </article>
                );
              })}

              {hasMore ? (
                <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs leading-6 text-muted-foreground">
                  فقط {toPersianDigits(entries.length)} سند نخست این فهرست نمایش داده شده است؛ برای دیدن اسناد قدیمی‌تر بازهٔ
                  تاریخ را محدود کنید.
                </p>
              ) : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
