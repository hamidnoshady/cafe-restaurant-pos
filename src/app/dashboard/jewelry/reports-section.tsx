"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import { PURITY_LABELS, type Purity, type Runner } from "./jewelry-manager";

const jewelryInputClass = `${inputClass} min-h-[52px] !border-stone-200 !bg-white shadow-none placeholder:text-stone-400 focus-visible:border-amber-500 focus-visible:ring-amber-400/30`;
const secondaryActionClass =
  "min-h-[44px] border-stone-200 bg-white px-3 text-xs text-stone-700 hover:border-amber-300 hover:bg-amber-50 hover:text-stone-950 focus-visible:border-amber-500 focus-visible:ring-amber-400/30";

interface WeightCount {
  id: string;
  countDate: string;
  purity: Purity;
  countedWeight: string;
  systemWeight: string;
  variance: string;
  variancePercent: number | null;
  notes: string | null;
}

interface ReconciliationRow {
  purity: Purity;
  systemWeight: string;
  pieces: number;
  lastCount: WeightCount | null;
}

interface ConsignorSummary {
  consignorId: string;
  name: string;
  itemsOnHand: number;
  totalOwed: number;
  totalPaid: number;
  balance: number;
}

export function ReportsSection({ busy, run }: { busy: boolean; run: Runner }) {
  const money = useMoney();
  const [reconciliation, setReconciliation] = useState<ReconciliationRow[]>([]);
  const [counts, setCounts] = useState<WeightCount[]>([]);
  const [summaries, setSummaries] = useState<ConsignorSummary[]>([]);

  const [purity, setPurity] = useState<Purity>("18");
  const [countedWeight, setCountedWeight] = useState("");
  const [notes, setNotes] = useState("");

  const load = useCallback(() => {
    api<{ reconciliation: ReconciliationRow[]; counts: WeightCount[] }>(
      "/api/jewelry/reports/weight-counts",
    ).then(({ ok, data }) => {
      if (ok) {
        setReconciliation(data.reconciliation);
        setCounts(data.counts);
      }
    });
    api<{ summaries: ConsignorSummary[] }>("/api/jewelry/reports/consignors").then(({ ok, data }) => {
      if (ok) setSummaries(data.summaries);
    });
  }, []);
  useEffect(load, [load]);

  async function recordCount(e: React.FormEvent) {
    e.preventDefault();
    if (!countedWeight.trim()) return;
    const ok = await run(() =>
      api("/api/jewelry/reports/weight-counts", {
        method: "POST",
        body: JSON.stringify({ purity, countedWeight, notes: notes.trim() || null }),
      }),
    );
    if (ok) {
      setCountedWeight("");
      setNotes("");
      load();
    }
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="order-2 min-w-0 space-y-4 md:order-1">
        <section aria-labelledby="jewelry-reconciliation-heading" className="min-w-0 overflow-hidden rounded-2xl bg-card">
          <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
            <h2 id="jewelry-reconciliation-heading" className="font-semibold text-stone-950">
              تطبیق وزنی
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              وزن خالص قطعات موجود طبق دفاتر، در برابر آخرین شمارش فیزیکی هر عیار. مغایرت به‌صورت خودکار به
              حساب‌ها نمی‌رود؛ برای اصلاح دفاتر از سند دستی استفاده کنید.
            </p>
          </div>

          <ul className="divide-y divide-stone-200/80">
            {reconciliation.map((row) => (
              <li key={row.purity} className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5">
                <div className="min-w-0">
                  <h3 className="font-semibold text-stone-950">{PURITY_LABELS[row.purity]}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatQuantity(row.systemWeight)} گرم در {toPersianDigits(String(row.pieces))} قطعه
                  </p>
                </div>
                <div className="text-xs text-stone-600">
                  {row.lastCount ? (
                    <>
                      <span>آخرین شمارش: {formatQuantity(row.lastCount.countedWeight)} گرم</span>
                      <span
                        className={`ms-2 rounded-full px-2 py-0.5 font-medium ${
                          Number(row.lastCount.variance) === 0
                            ? "bg-emerald-100 text-emerald-900"
                            : "bg-rose-100 text-rose-900"
                        }`}
                      >
                        مغایرت {formatQuantity(row.lastCount.variance)} گرم
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">شمارشی ثبت نشده است.</span>
                  )}
                </div>
              </li>
            ))}
            {reconciliation.length === 0 ? (
              <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">کالای وزنی موجودی ثبت نشده است.</li>
            ) : null}
          </ul>
        </section>

        <section aria-labelledby="jewelry-counts-heading" className="min-w-0 overflow-hidden rounded-2xl bg-card">
          <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
            <h2 id="jewelry-counts-heading" className="font-semibold text-stone-950">
              تاریخچهٔ شمارش
            </h2>
          </div>
          <ul className="divide-y divide-stone-200/80">
            {counts.map((count) => (
              <li key={count.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs sm:px-5">
                <span className="font-medium text-stone-800">
                  {formatJalali(count.countDate, { withMonthName: true })} — {PURITY_LABELS[count.purity]}
                </span>
                <span className="text-stone-600">
                  شمارش {formatQuantity(count.countedWeight)} / سیستم {formatQuantity(count.systemWeight)} گرم — مغایرت{" "}
                  {formatQuantity(count.variance)}
                  {count.variancePercent != null ? ` (${toPersianDigits(String(count.variancePercent))}٪)` : ""}
                </span>
              </li>
            ))}
            {counts.length === 0 ? (
              <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">شمارشی ثبت نشده است.</li>
            ) : null}
          </ul>
        </section>

        <section aria-labelledby="jewelry-consignor-statements-heading" className="min-w-0 overflow-hidden rounded-2xl bg-card">
          <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
            <h2 id="jewelry-consignor-statements-heading" className="font-semibold text-stone-950">
              صورت‌حساب امانت‌گذاران
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              بدهی هر امانت‌گذار از روی فروش‌های ثبت‌شده بازسازی می‌شود (ارزش فلز + اجرت)؛ سود فروش، کارمزد
              فروشگاه است و بدهی محسوب نمی‌شود.
            </p>
          </div>
          <ul className="divide-y divide-stone-200/80">
            {summaries.map((summary) => (
              <ConsignorStatementRow key={summary.consignorId} summary={summary} busy={busy} run={run} onPaid={load} />
            ))}
            {summaries.length === 0 ? (
              <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">امانت‌گذاری ثبت نشده است.</li>
            ) : null}
          </ul>
        </section>
      </div>

      <aside className="order-1 min-w-0 md:order-2">
        <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] md:sticky md:top-4 sm:p-5">
          <h2 className="font-semibold text-stone-950">ثبت شمارش فیزیکی</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            وزن اندازه‌گیری‌شده با ترازو را ثبت کنید؛ وزن سیستمی همان لحظه ذخیره می‌شود.
          </p>
          <form onSubmit={recordCount} className="mt-4">
            <Field label="عیار">
              <SearchableSelect
                className={jewelryInputClass}
                value={purity}
                onChange={(value) => setPurity(value as Purity)}
                options={(Object.keys(PURITY_LABELS) as Purity[]).map((p) => ({
                  value: p,
                  label: PURITY_LABELS[p],
                }))}
              />
            </Field>
            <Field label="وزن شمارش‌شده (گرم)">
              <input
                className={jewelryInputClass}
                dir="ltr"
                inputMode="decimal"
                value={countedWeight}
                onChange={(e) => setCountedWeight(e.target.value)}
                required
              />
            </Field>
            <Field label="توضیح">
              <input
                className={jewelryInputClass}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30"
            >
              ثبت شمارش
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}

function ConsignorStatementRow({
  summary,
  busy,
  run,
  onPaid,
}: {
  summary: ConsignorSummary;
  busy: boolean;
  run: Runner;
  onPaid: () => void;
}) {
  const money = useMoney();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    if (!amount.trim()) return;
    const ok = await run(() =>
      api(`/api/jewelry/consignors/${summary.consignorId}/payout`, {
        method: "POST",
        body: JSON.stringify({ amount: money.fromInput(Math.max(0, Math.round(Number(amount)))), paymentMethod }),
      }),
    );
    if (ok) {
      setAmount("");
      setOpen(false);
      onPaid();
    }
  }

  return (
    <li className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-stone-950">{summary.name}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {toPersianDigits(String(summary.itemsOnHand))} قطعه نزد فروشگاه — فروش‌شده {money.format(summary.totalOwed)} /
            پرداخت‌شده {money.format(summary.totalPaid)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-stone-950">مانده {money.format(summary.balance)}</span>
          {summary.balance > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryActionClass}
              disabled={busy}
              onClick={() => setOpen((v) => !v)}
            >
              تسویه
            </Button>
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="rounded-xl bg-amber-50/60 p-3 sm:p-4">
          <form onSubmit={pay} className="grid min-w-0 gap-3 sm:grid-cols-3">
            <Field label={`مبلغ (${money.unitLabel})`}>
              <input
                className={jewelryInputClass}
                dir="ltr"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </Field>
            <Field label="روش پرداخت">
              <SearchableSelect
                className={jewelryInputClass}
                value={paymentMethod}
                onChange={setPaymentMethod}
                options={[
                  { value: "cash", label: "نقدی" },
                  { value: "bank", label: "بانکی" },
                ]}
              />
            </Field>
            <div className="sm:col-span-3">
              <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 px-5 font-semibold">
                ثبت تسویه
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </li>
  );
}
