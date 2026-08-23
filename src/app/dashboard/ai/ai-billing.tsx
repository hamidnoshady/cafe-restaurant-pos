"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { creditUnitsForRial } from "@/lib/ai-billing";
import { formatPersianNumber } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useFeatureLocked } from "@/components/feature-lock";
import { cn } from "@/lib/utils";
import { inputClass } from "../ui";
import { SectionCard, cardClass } from "../page-chrome";

interface Billing {
  balanceRial: number;
  subscriptionPlan: { id: string; name: string; monthlyCreditRial: number } | null;
  subscriptionRenewsAt: string | null;
}

interface LedgerEntry {
  id: string;
  kind: "manual_grant" | "top_up" | "subscription" | "usage" | "usage_refund" | "usage_cancelled";
  amountRial: number;
  actualCostRial: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  note: string | null;
  createdAt: string;
}

interface CreditPackage {
  id: string;
  name: string;
  priceRial: number;
  creditAmountRial: number;
}

interface Data {
  billing: Billing;
  ledger: LedgerEntry[];
  packages: CreditPackage[];
  creditUnitRial: number;
  providerReady: boolean;
  error?: string;
}

const ledgerLabel: Record<LedgerEntry["kind"], string> = {
  manual_grant: "اعتبار دستی",
  top_up: "شارژ تأییدشده",
  subscription: "اعتبار اشتراک",
  usage: "مصرف دستیار",
  usage_refund: "بازگشت رزرو",
  usage_cancelled: "رزرو لغوشده",
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function AiBillingDashboard() {
  const money = useMoney();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPackageId, setSelectedPackageId] = useState("");
  const [note, setNote] = useState("");
  const [requesting, setRequesting] = useState(false);
  const locked = useFeatureLocked();

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/ai/billing");
      const body = (await res.json().catch(() => ({}))) as Data;
      if (!res.ok) throw new Error(body.error ?? "خواندن اعتبار ممکن نشد.");
      setData(body);
      setSelectedPackageId((current) =>
        current && body.packages.some((pkg) => pkg.id === current)
          ? current
          : body.packages[0]?.id ?? "",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "خواندن اعتبار ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // A business without the feature has no AI credit by definition, so the
    // preview shows that zero state rather than an error or a blank panel.
    if (locked) {
      setData({
        billing: { balanceRial: 0, subscriptionPlan: null, subscriptionRenewsAt: null },
        ledger: [],
        packages: [],
        creditUnitRial: 0,
        providerReady: false,
      });
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  const selected = useMemo(
    () => data?.packages.find((pkg) => pkg.id === selectedPackageId) ?? null,
    [data?.packages, selectedPackageId],
  );

  async function requestTopUp() {
    if (!selectedPackageId || requesting) return;
    setRequesting(true);
    try {
      const res = await fetch("/api/ai/billing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packageId: selectedPackageId, note }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "ثبت درخواست انجام نشد.");
      toast.success("درخواست شارژ ثبت شد و پس از تأیید مدیر پلتفرم، اعتبار شما اضافه می‌شود.");
      setNote("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "ثبت درخواست انجام نشد.");
    } finally {
      setRequesting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> در حال بارگذاری اعتبار…
      </div>
    );
  }
  if (!data) return null;

  const credits = creditUnitsForRial(data.billing.balanceRial, data.creditUnitRial);

  return (
    <div className="space-y-5">
      {!data.providerReady ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
          سرویس هوش مصنوعی هنوز توسط مدیر پلتفرم تکمیل نشده است. موجودی و درخواست‌های شما محفوظ می‌ماند.
        </div>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2">
        <div className={cn(cardClass, "p-4 sm:p-5")}>
          <div className="flex items-center gap-2 text-primary">
            <SparklesIcon className="size-5" />
            <p className="font-semibold">اعتبار قابل استفاده</p>
          </div>
          <p className="mt-3 text-2xl font-bold">{money.format(data.billing.balanceRial)}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.creditUnitRial > 0
              ? formatPersianNumber(credits) + " اعتبار نمایش‌داده‌شده"
              : "واحد اعتبار هنوز تعریف نشده است"}
          </p>
        </div>
        <div className={cn(cardClass, "p-4 sm:p-5")}>
          <p className="font-semibold">اشتراک AI</p>
          {data.billing.subscriptionPlan ? (
            <>
              <p className="mt-3 text-lg font-bold">{data.billing.subscriptionPlan.name}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {money.format(data.billing.subscriptionPlan.monthlyCreditRial)} اعتبار ماهانه
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {"تمدید بعدی: " + (data.billing.subscriptionRenewsAt ? formatDate(data.billing.subscriptionRenewsAt) : "—")}
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">اشتراک فعالی ندارید.</p>
          )}
        </div>
      </section>

      <SectionCard
        title="درخواست شارژ اعتبار"
        description="پس از پرداخت توافق‌شده، درخواست شما به مدیر پلتفرم ارسال می‌شود و اعتبار پس از تأیید اضافه خواهد شد."
      >
        {data.packages.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز بستهٔ شارژی برای این سرویس فعال نشده است.</p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[1fr_1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">بستهٔ شارژ</span>
              <SearchableSelect
                value={selectedPackageId}
                onChange={setSelectedPackageId}
                options={data.packages.map((pkg) => ({
                  value: pkg.id,
                  label: `${pkg.name} — ${money.format(pkg.priceRial)}`,
                }))}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">یادداشت پرداخت (اختیاری)</span>
              <input
                className={inputClass}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="مثلاً شماره پیگیری انتقال"
              />
            </label>
            <div className="self-end">
              <Button onClick={() => void requestTopUp()} disabled={!selected || requesting} className="w-full lg:w-auto">
                {requesting ? <Loader2Icon className="animate-spin" /> : null}
                ثبت درخواست
              </Button>
            </div>
          </div>
        )}
        {selected ? (
          <p className="mt-3 text-xs text-muted-foreground">
            با تأیید این بسته، {money.format(selected.creditAmountRial)} اعتبار به ماندهٔ شما افزوده می‌شود.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="تاریخچهٔ اعتبار و مصرف">
        {data.ledger.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز تراکنشی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-stone-200/80">
            {data.ledger.map((entry) => {
              const displayAmount =
                entry.kind === "usage" && entry.actualCostRial !== null
                  ? -entry.actualCostRial
                  : entry.amountRial;
              return (
                <li key={entry.id} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium">{ledgerLabel[entry.kind]}</p>
                    <p className="text-xs text-muted-foreground">
                      {entry.note ?? formatDate(entry.createdAt)}
                      {entry.inputTokens !== null && entry.outputTokens !== null
                        ? " · " + formatPersianNumber(entry.inputTokens + entry.outputTokens) + " توکن"
                        : ""}
                    </p>
                  </div>
                  <span className={displayAmount < 0 ? "font-semibold text-rose-600 dark:text-rose-300" : "font-semibold text-emerald-600 dark:text-emerald-300"}>
                    {displayAmount < 0 ? "−" : "+"}{money.format(Math.abs(displayAmount))}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
