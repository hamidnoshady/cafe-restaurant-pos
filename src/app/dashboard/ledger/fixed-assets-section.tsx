"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";

interface FixedAssetRow {
  id: string;
  name: string;
  acquisitionDate: string;
  cost: number;
  salvageValue: number;
  usefulLifeMonths: number;
  accumulatedDepreciation: number;
  bookValue: number;
}

const errorLabels: Record<string, string> = {
  fixed_asset_not_found: "دارایی پیدا نشد.",
  fixed_asset_has_depreciation: "برای این دارایی استهلاک ثبت شده و قابل حذف نیست.",
  period_label_required: "عنوان دوره الزامی است.",
  period_already_depreciated: "استهلاک این دوره قبلاً ثبت شده است.",
  fully_depreciated: "این دارایی به‌طور کامل مستهلک شده است.",
  fiscal_period_locked: "دوره مالی این تاریخ قفل است و امکان ثبت سند وجود ندارد.",
  fiscal_period_soft_closed: "دوره مالی این تاریخ بسته‌ی موقت است؛ فقط مالک یا حسابدار می‌تواند سند ثبت کند.",
};

function label(code: string | undefined): string {
  return errorLabels[code ?? ""] ?? errorMessage(code);
}

/**
 * Fixed-asset register + straight-line depreciation (Phase 22 Wave 5,
 * second slice, issue #160 §2). Registering an asset posts nothing;
 * depreciation is posted separately, per period, per asset — the same
 * "record, then post" split payroll's accrual/payment already uses.
 */
export function FixedAssetsSection({ busy, refreshKey }: { busy: boolean; refreshKey: number }) {
  const money = useMoney();
  const [assets, setAssets] = useState<FixedAssetRow[] | null>(null);
  const [localError, setLocalError] = useState("");

  const [name, setName] = useState("");
  const [acquisitionDate, setAcquisitionDate] = useState("");
  const [cost, setCost] = useState("");
  const [salvageValue, setSalvageValue] = useState("");
  const [usefulLifeMonths, setUsefulLifeMonths] = useState("");

  const [depreciating, setDepreciating] = useState<string | null>(null);
  const [periodLabel, setPeriodLabel] = useState("");
  const [entryDate, setEntryDate] = useState("");

  function refresh() {
    api<{ fixedAssets: FixedAssetRow[] }>("/api/ledger/fixed-assets").then(({ ok, data }) => {
      if (ok) setAssets(data.fixedAssets);
    });
  }
  useEffect(refresh, [refreshKey]);

  async function submitAsset(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    if (!name.trim() || !acquisitionDate || !cost.trim() || !usefulLifeMonths.trim()) return;
    let costRial: number;
    let salvageRial: number;
    try {
      costRial = money.parse(cost);
      salvageRial = salvageValue.trim() ? money.parse(salvageValue) : 0;
    } catch {
      return;
    }
    const { ok, data } = await api<{ error?: string }>("/api/ledger/fixed-assets", {
      method: "POST",
      body: JSON.stringify({
        name,
        acquisitionDate,
        cost: costRial,
        salvageValue: salvageRial,
        usefulLifeMonths: Number(usefulLifeMonths),
      }),
    });
    if (!ok) return setLocalError(label((data as { error?: string }).error));
    setName("");
    setAcquisitionDate("");
    setCost("");
    setSalvageValue("");
    setUsefulLifeMonths("");
    refresh();
  }

  async function submitDepreciation(e: React.FormEvent, assetId: string) {
    e.preventDefault();
    setLocalError("");
    if (!periodLabel.trim()) return;
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/fixed-assets/${assetId}/depreciate`, {
      method: "POST",
      body: JSON.stringify({ periodLabel, entryDate: entryDate || undefined }),
    });
    if (!ok) return setLocalError(label((data as { error?: string }).error));
    setDepreciating(null);
    setPeriodLabel("");
    setEntryDate("");
    refresh();
  }

  async function remove(assetId: string) {
    setLocalError("");
    const { ok, data } = await api(`/api/ledger/fixed-assets/${assetId}`, { method: "DELETE" });
    if (!ok) return setLocalError(label((data as { error?: string }).error));
    refresh();
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-4 sm:p-5">
        <p className="text-xs font-semibold text-amber-700">دفتر دارایی</p>
        <h2 className="mt-1">ثبت دارایی ثابت</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          استهلاک به روش خط مستقیم محاسبه می‌شود؛ ثبت دارایی به‌تنهایی سندی صادر نمی‌کند — استهلاک هر دوره را جداگانه ثبت کنید.
        </p>
        {localError ? <p className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{localError}</p> : null}
        <form onSubmit={submitAsset} className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">نام دارایی</span>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً یخچال صنعتی" required />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">تاریخ خرید</span>
            <JalaliDatePicker value={acquisitionDate} onChange={setAcquisitionDate} placeholder="تاریخ خرید" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">عمر مفید (ماه)</span>
            <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={usefulLifeMonths} onChange={(e) => setUsefulLifeMonths(e.target.value)} placeholder="۶۰" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">بهای تمام‌شده ({money.unitLabel})</span>
            <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="۰" />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">ارزش اسقاط ({money.unitLabel}) <span className="font-normal text-muted-foreground">(اختیاری)</span></span>
            <PersianNumberInput className={inputClass} dir="ltr" inputMode="numeric" value={salvageValue} onChange={(e) => setSalvageValue(e.target.value)} placeholder="۰" />
          </label>
          <div className="md:col-span-2 xl:col-span-3">
            <div className="max-w-xs">
              <PrimaryButton disabled={busy || !name.trim() || !acquisitionDate || !cost.trim() || !usefulLifeMonths.trim()}>
                ثبت دارایی
              </PrimaryButton>
            </div>
          </div>
        </form>
      </section>

      <section className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-4 sm:p-5">
        <div className="mb-4">
          <p className="text-xs font-semibold text-amber-700">فهرست دارایی‌ها</p>
          <h2 className="mt-1">دارایی‌های ثابت</h2>
        </div>
        {!assets ? (
          <LoadingSkeleton rows={3} />
        ) : assets.length === 0 ? (
          <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">
            هنوز دارایی ثابتی ثبت نشده است.
          </p>
        ) : (
          <div className="space-y-3">
            {assets.map((a) => (
              <article key={a.id} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate">{a.name}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      خرید: {toPersianDigits(formatJalali(a.acquisitionDate))} — عمر مفید: {toPersianDigits(String(a.usefulLifeMonths))} ماه
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <SecondaryButton onClick={() => setDepreciating(depreciating === a.id ? null : a.id)} disabled={busy}>
                      ثبت استهلاک این دوره
                    </SecondaryButton>
                    {a.accumulatedDepreciation === 0 ? (
                      <SecondaryButton onClick={() => remove(a.id)} disabled={busy}>حذف</SecondaryButton>
                    ) : null}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-stone-100 pt-3 text-sm sm:grid-cols-4">
                  <div><dt className="text-xs text-muted-foreground">بهای تمام‌شده</dt><dd className="mt-1 tabular-nums">{money.format(a.cost)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">ارزش اسقاط</dt><dd className="mt-1 tabular-nums">{money.format(a.salvageValue)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">استهلاک انباشته</dt><dd className="mt-1 tabular-nums">{money.format(a.accumulatedDepreciation)}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">ارزش دفتری</dt><dd className="mt-1 font-semibold tabular-nums">{money.format(a.bookValue)}</dd></div>
                </dl>

                {depreciating === a.id ? (
                  <form onSubmit={(e) => submitDepreciation(e, a.id)} className="mt-4 grid gap-3 border-t border-stone-100 pt-4 sm:grid-cols-[1fr_1fr_auto]">
                    <label className="block">
                      <span className="mb-1.5 block text-xs text-muted-foreground">عنوان دوره</span>
                      <input className={inputClass} value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} placeholder="مثلاً ۱۴۰۳/۰۵" required />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-xs text-muted-foreground">تاریخ سند</span>
                      <JalaliDatePicker value={entryDate} onChange={setEntryDate} placeholder="امروز" />
                    </label>
                    <div className="flex items-end">
                      <PrimaryButton disabled={busy || !periodLabel.trim()}>ثبت</PrimaryButton>
                    </div>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
