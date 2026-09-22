"use client";

/**
 * Super-admin view of one business's wallet: balance, manual grant/deduct,
 * ledger, entitlements, payments and per-feature usage.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { Loader2Icon, SparklesIcon, WalletIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass } from "../../../ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";

interface BusinessBillingData {
  business: { id: string; name: string; plan: string };
  wallet: { balanceRial: number; totalToppedUpRial: number; totalSpentRial: number };
  ledger: {
    id: string;
    kind: string;
    direction: "credit" | "debit";
    amountRial: number;
    note: string | null;
    featureKey: string | null;
    createdAt: string;
  }[];
  entitlements: {
    featureKey: string;
    source: string;
    expiresAt: string | null;
    freeUntil: string | null;
    freeLimit: number | null;
  }[];
  payments: {
    id: string;
    purpose: string;
    amountRial: number;
    status: string;
    gatewayRef: string | null;
    description: string;
    createdAt: string;
  }[];
  usage: { featureKey: string; usedCount: number; chargedCount: number; spentRial: number }[];
  litellm?: LiteLlmSpend;
}

interface LiteLlmSpend {
  costingEnabled: boolean;
  usdRialRate: number | null;
  totalSpendUsd: number;
  totalSpendRial: number;
  keys: {
    locationId: string | null;
    keyAlias: string | null;
    effectiveModel: string;
    hasVirtualKey: boolean;
    spendUsd: number;
    spendRial: number;
    syncedAt: string | null;
    syncError: string | null;
  }[];
}

function toman(rial: number): string {
  return toPersianDigits(Math.round(rial / 10).toLocaleString("en-US").replace(/,/g, "٬"));
}

const KIND_LABELS: Record<string, string> = {
  top_up: "شارژ",
  payment: "پرداخت",
  admin_grant: "شارژ دستی",
  refund: "بازگشت وجه",
  feature_charge: "هزینهٔ قابلیت",
  addon_purchase: "خرید افزونه",
  plan_fee: "هزینهٔ پلن",
  subscription: "اشتراک",
  admin_adjust: "تعدیل دستی",
  free_promo: "استفادهٔ رایگان",
};

export default function BusinessBillingPage() {
  const params = useParams<{ id: string }>();
  const businessId = decodeURIComponent(params.id);
  const [data, setData] = useState<BusinessBillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [amountToman, setAmountToman] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const { ok, data: res } = await api<BusinessBillingData & { error?: string }>(
      `/api/platform/billing/businesses/${businessId}`,
    );
    if (ok) setData(res);
    else setError(res.error ?? "بارگذاری انجام نشد.");
    setLoading(false);
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function adjust(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const amount = Number(toLatinDigits(amountToman || "0"));
    if (!amount) {
      setError("مبلغ را وارد کنید (برای کسر، منفی).");
      return;
    }
    setBusy(true);
    setError("");
    setInfo("");
    const { ok, data: res } = await api<{ error?: string }>(
      `/api/platform/billing/businesses/${businessId}`,
      {
        method: "POST",
        body: JSON.stringify({ amountRial: amount * 10, note: note.trim() || undefined }),
      },
    );
    setBusy(false);
    if (ok) {
      setInfo(amount > 0 ? "اعتبار افزوده شد." : "اعتبار کسر شد.");
      setAmountToman("");
      setNote("");
      void load();
    } else {
      setError(res.error === "insufficient_credits" ? "موجودی برای کسر این مبلغ کافی نیست." : "عملیات انجام نشد.");
    }
  }

  async function syncLiteLlm() {
    setSyncing(true);
    setError("");
    setInfo("");
    const { ok, data: res } = await api<{ litellm?: LiteLlmSpend; error?: string }>(
      `/api/platform/billing/businesses/${businessId}`,
      { method: "POST", body: JSON.stringify({ action: "sync_litellm_spend" }) },
    );
    setSyncing(false);
    if (ok && res.litellm) {
      setData((current) => (current ? { ...current, litellm: res.litellm } : current));
      setInfo("مصرف LiteLLM به‌روزرسانی شد.");
    } else {
      setError(res.error ?? "به‌روزرسانی مصرف LiteLLM انجام نشد.");
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin" />
      </div>
    );
  }
  if (!data) return <ErrorBox>{error || "داده‌ای پیدا نشد."}</ErrorBox>;

  return (
    <div className="space-y-4 sm:space-y-6">
      {error && <ErrorBox>{error}</ErrorBox>}
      {info && <InfoBox>{info}</InfoBox>}

      <Card title={`کیف پول — ${data.business.name}`}>
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-700 dark:text-amber-300">
            <WalletIcon className="size-6" />
          </span>
          <div>
            <p className="text-2xl font-extrabold tabular-nums text-foreground">
              {toman(data.wallet.balanceRial)} <span className="text-sm font-normal text-muted-foreground">تومان</span>
            </p>
            <p className="text-xs text-muted-foreground">
              مجموع شارژ: {toman(data.wallet.totalToppedUpRial)} ت · مجموع مصرف: {toman(data.wallet.totalSpentRial)} ت
            </p>
          </div>
        </div>

        <form onSubmit={adjust} className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-3 sm:items-end">
          <Field label="مبلغ (تومان — برای کسر منفی وارد کنید)">
            <PersianNumberInput
              className={inputClass}
              inputMode="numeric"
              allowNegative
              value={amountToman}
              onChange={(e) => setAmountToman(e.target.value)}
              placeholder="مثلاً ۵۰۰٬۰۰۰ یا ۱۰۰٬۰۰۰-"
            />
          </Field>
          <Field label="یادداشت (اختیاری)">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : "اعمال شارژ/کسر"}
          </Button>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">
          هزینهٔ هوش مصنوعی به‌صورت خودکار توسط LiteLLM محاسبه و از همین اعتبار کسر می‌شود؛ برای افزایش یا
          کاهش دستی مصرف کاربر از فرم بالا استفاده کنید.
        </p>
      </Card>

      <Card title="مصرف هوش مصنوعی (LiteLLM)">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-11 items-center justify-center rounded-2xl bg-violet-500/15 text-violet-700 dark:text-violet-300">
              <SparklesIcon className="size-5" />
            </span>
            <div>
              <p className="text-lg font-extrabold tabular-nums text-foreground">
                {data.litellm && data.litellm.usdRialRate
                  ? `${toman(data.litellm.totalSpendRial)} تومان`
                  : "—"}
                <span className="mr-2 text-xs font-normal text-muted-foreground" dir="ltr">
                  {toPersianDigits((data.litellm?.totalSpendUsd ?? 0).toFixed(4))} $
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                هزینهٔ گزارش‌شدهٔ LiteLLM برای این کسب‌وکار
                {data.litellm?.costingEnabled
                  ? " · تسویه بر پایهٔ LiteLLM فعال است"
                  : " · تسویه بر پایهٔ LiteLLM غیرفعال است"}
              </p>
            </div>
          </div>
          <Button type="button" onClick={() => void syncLiteLlm()} disabled={syncing}>
            {syncing ? <Loader2Icon className="size-4 animate-spin" /> : "به‌روزرسانی مصرف"}
          </Button>
        </div>

        {!data.litellm || data.litellm.keys.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            هنوز کلید مجازی LiteLLM برای این کسب‌وکار صادر نشده است.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-right text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-1">کلید / شعبه</th>
                  <th className="py-2">مدل</th>
                  <th className="py-2">هزینه ($)</th>
                  <th className="py-2">هزینه (تومان)</th>
                  <th className="py-2">به‌روزرسانی</th>
                </tr>
              </thead>
              <tbody>
                {data.litellm.keys.map((k, idx) => (
                  <tr key={`${k.keyAlias ?? "biz"}-${k.locationId ?? "all"}-${idx}`} className="border-b border-border">
                    <td className="py-2 pr-1">
                      <span dir="ltr" className="font-medium text-foreground">
                        {k.keyAlias ?? "—"}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {k.locationId ? `شعبه: ${k.locationId.slice(0, 8)}` : "کل کسب‌وکار"}
                      </span>
                    </td>
                    <td className="py-2" dir="ltr">{k.effectiveModel}</td>
                    <td className="py-2 tabular-nums" dir="ltr">{toPersianDigits(k.spendUsd.toFixed(4))}</td>
                    <td className="py-2 tabular-nums">
                      {data.litellm?.usdRialRate ? `${toman(k.spendRial)} ت` : "—"}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {k.syncError ? (
                        <span className="text-red-700 dark:text-red-300">{k.syncError}</span>
                      ) : k.syncedAt ? (
                        formatJalali(k.syncedAt, { withMonthName: true, withTime: true })
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="قابلیت‌های فعال (اشتراک/خرید/هدیه)">
        {data.entitlements.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">قابلیت فعال مستقیمی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {data.entitlements.map((e) => (
              <li key={e.featureKey} className="flex items-center justify-between gap-2 py-2">
                <span className="text-foreground">{e.featureKey}</span>
                <span className="text-xs text-muted-foreground">
                  {e.source}
                  {e.freeUntil ? ` · رایگان تا ${formatJalali(e.freeUntil, { withMonthName: true })}` : ""}
                  {e.freeLimit != null ? ` · ${toPersianDigits(e.freeLimit)} استفاده رایگان` : ""}
                  {e.expiresAt ? ` · انقضا ${formatJalali(e.expiresAt, { withMonthName: true })}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="مصرف قابلیت‌های پولی">
        {data.usage.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">هنوز مصرفی ثبت نشده است.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-right text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2">قابلیت</th>
                <th className="py-2">تعداد استفاده</th>
                <th className="py-2">استفادهٔ پولی</th>
                <th className="py-2">هزینه</th>
              </tr>
            </thead>
            <tbody>
              {data.usage.map((u) => (
                <tr key={u.featureKey} className="border-b border-border">
                  <td className="py-2 text-foreground">{u.featureKey}</td>
                  <td className="py-2 tabular-nums">{toPersianDigits(u.usedCount)}</td>
                  <td className="py-2 tabular-nums">{toPersianDigits(u.chargedCount)}</td>
                  <td className="py-2 tabular-nums">{toman(u.spentRial)} ت</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="دفتر اعتبار">
        <ul className="divide-y divide-border text-sm">
          {data.ledger.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-foreground">{l.note || KIND_LABELS[l.kind] || l.kind}</p>
                <p className="text-xs text-muted-foreground">
                  {formatJalali(l.createdAt, { withMonthName: true, withTime: true })}
                  {l.featureKey ? ` · ${l.featureKey}` : ""}
                </p>
              </div>
              <span
                className={`shrink-0 tabular-nums font-semibold ${
                  l.direction === "credit" ? "text-emerald-700 dark:text-emerald-300" : "text-red-700 dark:text-red-300"
                }`}
              >
                {l.direction === "credit" ? "+" : "−"}
                {toman(l.amountRial)} ت
              </span>
            </li>
          ))}
          {data.ledger.length === 0 && (
            <li className="py-4 text-center text-muted-foreground">تراکنشی ثبت نشده است.</li>
          )}
        </ul>
      </Card>

      <Card title="پرداخت‌ها">
        <ul className="divide-y divide-border text-sm">
          {data.payments.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-foreground">{p.description || p.purpose}</p>
                <p className="text-xs text-muted-foreground">
                  {formatJalali(p.createdAt, { withMonthName: true, withTime: true })}
                  {p.gatewayRef ? ` · پیگیری: ${toPersianDigits(p.gatewayRef)}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="tabular-nums">{toman(p.amountRial)} ت</span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    p.status === "verified"
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                      : p.status === "failed" || p.status === "cancelled"
                        ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                        : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  }`}
                >
                  {p.status === "verified" ? "موفق" : p.status === "failed" ? "ناموفق" : p.status === "cancelled" ? "لغو" : "در انتظار"}
                </span>
              </div>
            </li>
          ))}
          {data.payments.length === 0 && <li className="py-4 text-center text-muted-foreground">پرداختی نیست.</li>}
        </ul>
      </Card>
    </div>
  );
}
