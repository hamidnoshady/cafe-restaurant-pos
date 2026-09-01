"use client";

/**
 * Tenant billing surface: wallet balance, credit top-up through the platform
 * payment gateway (Zarinpal), available plans, and the business's payment
 * history. The credit badge in the chrome links here; this page is where money
 * actually moves.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  CheckCircle2Icon,
  SparklesIcon,
  WalletIcon,
  XCircleIcon,
} from "lucide-react";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionCard, SectionCardSkeleton, cardClass } from "../page-chrome";
import { cn } from "@/lib/utils";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "../ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";

interface Wallet {
  balanceRial: number;
  totalToppedUpRial: number;
  totalSpentRial: number;
}
interface Pkg {
  id: string;
  name: string;
  priceRial: number;
  creditRial: number;
}
interface Plan {
  key: string;
  name: string;
  description: string | null;
  monthlyPriceRial: number | null;
}
interface Payment {
  id: string;
  purpose: "top_up" | "plan_purchase" | "addon_purchase";
  amountRial: number;
  creditRial: number;
  status: string;
  gateway: string;
  gatewayRef: string | null;
  description: string;
  createdAt: string;
}

function toman(rial: number): string {
  return toPersianDigits((rial / 10).toLocaleString("en-US").replace(/,/g, "٬"));
}

const STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  redirect: "هدایت به درگاه",
  verified: "پرداخت موفق",
  failed: "ناموفق",
  cancelled: "لغو شده",
};

export function BillingManager() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [customAmountToman, setCustomAmountToman] = useState<string>("");
  const verifiedRef = useRef(false);

  const load = useCallback(async () => {
    const [walletRes, pkgRes, payRes] = await Promise.all([
      api<{ wallet: Wallet }>("/api/billing/wallet"),
      api<{ packages: Pkg[] }>("/api/billing/packages"),
      api<{ payments: Payment[] }>("/api/billing/payments"),
    ]);
    if (walletRes.ok) setWallet(walletRes.data.wallet);
    if (pkgRes.ok) setPackages(pkgRes.data.packages ?? []);
    if (payRes.ok) setPayments(payRes.data.payments ?? []);
    // Plans come from the platform catalogue through a public-ish tenant read;
    // the packages endpoint covers top-up, plans are fetched best-effort.
    try {
      const plansRes = await api<{ plans: Plan[] }>("/api/billing/plans");
      if (plansRes.ok) setPlans(plansRes.data.plans ?? []);
    } catch {
      // plans are optional to the page
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Gateway return: ?payment=…&Authority=…&Status=… (Zarinpal)
  useEffect(() => {
    const paymentId = searchParams.get("payment");
    const authority = searchParams.get("Authority");
    const status = searchParams.get("Status");
    if (!paymentId || !authority || verifiedRef.current) return;
    verifiedRef.current = true;
    (async () => {
      setBusy("verify");
      const { ok, data } = await api<{ payment?: { status: string; creditRial: number }; message?: string }>(
        "/api/billing/payments/verify",
        {
          method: "POST",
          body: JSON.stringify({ paymentId, authority, status: status ?? "NOK" }),
        },
      );
      setBusy(null);
      if (ok && data.payment?.status === "verified") {
        setInfo("پرداخت با موفقیت انجام شد و اعتبار شما افزوده شد.");
      } else {
        setError(data.message ?? "پرداخت تأیید نشد. اگر مبلغ کسر شده، حداکثر پس از ۲۴ ساعت بازمی‌گردد.");
      }
      router.replace("/dashboard/billing");
      void load();
    })();
  }, [searchParams, load, router]);

  async function startPayment(body: Record<string, unknown>, busyKey: string) {
    setError("");
    setInfo("");
    setBusy(busyKey);
    try {
      const { ok, data } = await api<{ redirectUrl?: string | null; gateway?: string; error?: string; message?: string }>(
        "/api/billing/payments",
        { method: "POST", body: JSON.stringify(body) },
      );
      if (!ok) {
        setError(data.message ?? errorMessage(data.error));
        setBusy(null);
        return;
      }
      if (data.redirectUrl) {
        // Full navigation to the gateway; it returns to our callback.
        window.location.assign(data.redirectUrl);
        return;
      }
      // Manual gateway: no redirect — inform the owner.
      setInfo("درخواست پرداخت ثبت شد و پس از تأیید مدیر سامانه، اعتبار شما افزوده می‌شود.");
      void load();
      setBusy(null);
    } catch {
      setError("خطا در ثبت پرداخت. دوباره تلاش کنید.");
      setBusy(null);
    }
  }

  function topupPackage(pkg: Pkg) {
    void startPayment({ kind: "topup", packageId: pkg.id }, `pkg-${pkg.id}`);
  }

  function topupCustom() {
    const amountToman = Math.floor(Number(toLatinDigits(customAmountToman || "0")));
    if (!Number.isFinite(amountToman) || amountToman < 10_000) {
      setError("حداقل مبلغ شارژ ۱۰٬۰۰۰ تومان است.");
      return;
    }
    void startPayment({ kind: "topup", amountRial: amountToman * 10 }, "custom");
  }

  if (loading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="در حال بارگذاری">
        <PageHeader title="اعتبار و پرداخت‌ها" description="شارژ حساب، پلن‌ها و تاریخچهٔ پرداخت" />
        <SectionCardSkeleton label="اعتبار فعلی" rows={2} />
        <SectionCardSkeleton label="شارژ اعتبار" rows={4} />
        <SectionCardSkeleton label="تاریخچهٔ پرداخت‌ها" rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title="اعتبار و پرداخت‌ها" description="شارژ حساب، پلن‌ها و تاریخچهٔ پرداخت" />

      {error && <ErrorBox>{error}</ErrorBox>}
      {info && <InfoBox>{info}</InfoBox>}

      {/* Balance */}
      <SectionCard title="اعتبار فعلی">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
              <WalletIcon className="size-6" />
            </span>
            <div>
              <p className="text-2xl font-extrabold tabular-nums">
                {toman(wallet?.balanceRial ?? 0)} <span className="text-base font-normal">تومان</span>
              </p>
              <p className="text-xs text-muted-foreground">
                مجموع شارژ: {toman(wallet?.totalToppedUpRial ?? 0)} تومان · مجموع مصرف:{" "}
                {toman(wallet?.totalSpentRial ?? 0)} تومان
              </p>
            </div>
          </div>
          {busy === "verify" && (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              در حال بررسی نتیجهٔ پرداخت…
            </span>
          )}
        </div>
      </SectionCard>

      {/* Top-up packages */}
      <SectionCard title="شارژ اعتبار">
        <p className="mb-3 text-sm text-muted-foreground">
          یکی از بسته‌ها را انتخاب کنید یا مبلغ دلخواه وارد کنید. پرداخت از طریق درگاه امن زرین‌پال انجام می‌شود.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {packages.map((pkg) => {
            const bonus = pkg.creditRial - pkg.priceRial;
            return (
              <div
                key={pkg.id}
                className={cn("flex flex-col p-4", cardClass)}
              >
                <p className="font-bold">{pkg.name}</p>
                <p className="mt-2 text-xl font-extrabold tabular-nums">
                  {toman(pkg.creditRial)} <span className="text-sm font-normal">تومان اعتبار</span>
                </p>
                {bonus > 0 && (
                  <p className="mt-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    {toPersianDigits((bonus / 10).toLocaleString("en-US").replace(/,/g, "٬"))} تومان هدیه
                  </p>
                )}
                <Button
                  className="mt-3 w-full"
                  disabled={busy !== null}
                  onClick={() => topupPackage(pkg)}
                >
                  {busy === `pkg-${pkg.id}` ? "در حال انتقال به درگاه…" : `پرداخت ${toman(pkg.priceRial)} تومان`}
                </Button>
              </div>
            );
          })}
        </div>

        <div className="mt-4 rounded-2xl border border-dashed border-border p-4">
          <p className="mb-2 text-sm font-semibold">شارژ با مبلغ دلخواه</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">مبلغ (تومان)</label>
              <PersianNumberInput
                className={inputClass}
                inputMode="numeric"
                placeholder="مثلاً ۲۰۰٬۰۰۰"
                value={customAmountToman}
                onChange={(e) => setCustomAmountToman(e.target.value)}
              />
            </div>
            <Button variant="secondary" disabled={busy !== null} onClick={topupCustom}>
              {busy === "custom" ? "در حال انتقال…" : "پرداخت و شارژ"}
            </Button>
          </div>
        </div>
      </SectionCard>

      {/* Plans */}
      {plans.length > 0 && (
        <SectionCard title="پلن‌ها">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => (
              <div key={plan.key} className={cn("flex flex-col p-4", cardClass)}>
                <p className="flex items-center gap-2 font-bold">
                  <SparklesIcon className="size-4 text-amber-600 dark:text-amber-400" /> {plan.name}
                </p>
                {plan.description && <p className="mt-1 text-xs text-muted-foreground">{plan.description}</p>}
                <p className="mt-3 text-lg font-extrabold tabular-nums">
                  {plan.monthlyPriceRial == null || plan.monthlyPriceRial === 0
                    ? "رایگان"
                    : `${toman(plan.monthlyPriceRial)} تومان / ماهانه`}
                </p>
                {plan.monthlyPriceRial != null && plan.monthlyPriceRial > 0 && (
                  <Button
                    variant="secondary"
                    className="mt-3 w-full"
                    disabled={busy !== null}
                    onClick={() => void startPayment({ kind: "plan", planKey: plan.key }, `plan-${plan.key}`)}
                  >
                    {busy === `plan-${plan.key}` ? "در حال انتقال…" : "خرید اشتراک"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Payment history */}
      <SectionCard title="تاریخچهٔ پرداخت‌ها">
        {payments.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">هنوز پرداختی ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-border">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.description || STATUS_LABELS[p.status]}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatJalali(p.createdAt, { withMonthName: true, withTime: true })}
                    {p.gatewayRef ? ` · کد پیگیری: ${toPersianDigits(p.gatewayRef)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-semibold tabular-nums">{toman(p.amountRial)} تومان</span>
                  {p.status === "verified" ? (
                    <CheckCircle2Icon className="size-5 text-emerald-600 dark:text-emerald-400" />
                  ) : p.status === "failed" || p.status === "cancelled" ? (
                    <XCircleIcon className="size-5 text-destructive" />
                  ) : (
                    <span className="size-2.5 rounded-full bg-muted-foreground/50" aria-label="در انتظار" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
