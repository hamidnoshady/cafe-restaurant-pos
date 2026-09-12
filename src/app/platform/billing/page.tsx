"use client";

/**
 * Super-admin «پرداخت‌ها» console:
 *  - payment gateway configuration (Zarinpal merchant id, sandbox, callback),
 *  - credit top-up package catalogue,
 *  - every payment across businesses, with manual approve/reject for the
 *    bank-transfer gateway and failed gateway attempts.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { CheckCircle2Icon, Loader2Icon, PlusIcon, Trash2Icon, WalletIcon, XCircleIcon } from "lucide-react";
import { formatJalali } from "@/lib/jalali";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, PlatformPageSkeleton, useCan } from "../ui";
import { PersianNumberInput } from "@/components/ui/persian-number-input";

interface GatewayConfig {
  gateway: "manual" | "zarinpal";
  merchantIdSet: boolean;
  merchantIdHint: string;
  sandbox: boolean;
  callbackUrl: string;
  currency: "IRR" | "IRT";
}
interface Pkg {
  id: string;
  name: string;
  priceRial: number;
  creditRial: number;
  isActive: boolean;
  sortOrder: number;
}
interface Payment {
  id: string;
  businessId: string;
  businessName?: string | null;
  purpose: string;
  amountRial: number;
  creditRial: number;
  status: string;
  gateway: string;
  gatewayRef: string | null;
  description: string;
  createdAt: string;
}

function toman(rial: number): string {
  return toPersianDigits(Math.round(rial / 10).toLocaleString("en-US").replace(/,/g, "٬"));
}

const STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار",
  redirect: "در درگاه",
  verified: "موفق",
  failed: "ناموفق",
  cancelled: "لغو شده",
};

export default function PlatformBillingPage() {
  const canManage = useCan()("billing.manage");
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<GatewayConfig | null>(null);
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [cfgRes, pkgRes, payRes] = await Promise.all([
      api<{ config: GatewayConfig }>("/api/platform/billing/config"),
      api<{ packages: Pkg[] }>("/api/platform/billing/packages"),
      api<{ payments: Payment[] }>(
        `/api/platform/billing/payments${filter === "all" ? "" : `?status=${filter}`}`,
      ),
    ]);
    if (cfgRes.ok) setConfig(cfgRes.data.config);
    if (pkgRes.ok) setPackages(pkgRes.data.packages ?? []);
    if (payRes.ok) setPayments(payRes.data.payments ?? []);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveConfig(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (!config) return;
    setError("");
    setBusy("config");
    const form = new FormData(ev.currentTarget);
    const merchantInput = String(form.get("merchantId") ?? "").trim();
    const body: Record<string, unknown> = {
      gateway: form.get("gateway"),
      sandbox: form.get("sandbox") === "on",
      callbackUrl: String(form.get("callbackUrl") ?? ""),
      currency: form.get("currency"),
    };
    // Only send the merchant id when the operator typed a new one.
    if (merchantInput) body.merchantId = merchantInput;
    const { ok, data } = await api<{ config?: GatewayConfig; error?: string }>(
      "/api/platform/billing/config",
      { method: "PUT", body: JSON.stringify(body) },
    );
    setBusy(null);
    if (ok && data.config) {
      setConfig(data.config);
      setInfo("تنظیمات درگاه ذخیره شد.");
    } else {
      setError(data.error ?? "ذخیره انجام نشد.");
    }
  }

  async function savePackage(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setError("");
    const form = new FormData(ev.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const priceToman = Number(toLatinDigits(String(form.get("priceToman") ?? "0")));
    const creditToman = Number(toLatinDigits(String(form.get("creditToman") ?? "0")));
    if (!name || priceToman <= 0 || creditToman <= 0) {
      setError("نام بسته، مبلغ پرداختی و مبلغ اعتبار الزامی است.");
      return;
    }
    setBusy("package");
    const { ok, data } = await api<{ error?: string }>("/api/platform/billing/packages", {
      method: "POST",
      body: JSON.stringify({
        name,
        priceRial: priceToman * 10,
        creditRial: creditToman * 10,
        isActive: form.get("isActive") !== "off",
        sortOrder: packages.length + 1,
      }),
    });
    setBusy(null);
    if (ok) {
      setInfo("بسته ذخیره شد.");
      (ev.currentTarget as HTMLFormElement).reset();
      void load();
    } else {
      setError(data.error ?? "ذخیره بسته انجام نشد.");
    }
  }

  async function togglePackage(pkg: Pkg) {
    setBusy(`pkg-${pkg.id}`);
    await api("/api/platform/billing/packages", {
      method: "POST",
      body: JSON.stringify({
        id: pkg.id,
        name: pkg.name,
        priceRial: pkg.priceRial,
        creditRial: pkg.creditRial,
        isActive: !pkg.isActive,
        sortOrder: pkg.sortOrder,
      }),
    });
    setBusy(null);
    void load();
  }

  async function deletePackage(id: string) {
    setBusy(`pkg-del-${id}`);
    await api(`/api/platform/billing/packages/${id}`, { method: "DELETE" });
    setBusy(null);
    void load();
  }

  async function review(paymentId: string, action: "approve" | "reject") {
    setBusy(`pay-${paymentId}`);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(
      `/api/platform/billing/payments/${paymentId}/review`,
      { method: "POST", body: JSON.stringify({ action }) },
    );
    setBusy(null);
    if (ok) {
      setInfo(action === "approve" ? "پرداخت تأیید و اعتبار کسب‌وکار افزوده شد." : "پرداخت رد شد.");
      void load();
    } else {
      setError(data.message ?? data.error ?? "عملیات انجام نشد.");
    }
  }

  if (loading) return <PlatformPageSkeleton />;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
      <header className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-sky-500/15 text-sky-700 dark:text-sky-300">
          <WalletIcon className="size-5" />
        </span>
        <div>
          <h1 className="text-lg font-bold text-foreground">پرداخت‌ها و اعتبارها</h1>
          <p className="text-sm text-muted-foreground">
            درگاه پرداخت، بسته‌های شارژ اعتبار و رسیدهای پرداخت کسب‌وکارها
          </p>
        </div>
      </header>

      {error && <ErrorBox>{error}</ErrorBox>}
      {info && <InfoBox>{info}</InfoBox>}

      {canManage && config && (
        <Card title="تنظیمات درگاه پرداخت">
          <form onSubmit={saveConfig} className="grid gap-4 sm:grid-cols-2">
            <Field label="درگاه">
              <select name="gateway" defaultValue={config.gateway} className={inputClass}>
                <option value="zarinpal">زرین‌پال (پرداخت آنلاین)</option>
                <option value="manual">پرداخت دستی / کارت‌به‌کارت (تأیید توسط مدیر)</option>
              </select>
            </Field>
            <Field label="واحد پولی درگاه">
              <select name="currency" defaultValue={config.currency} className={inputClass}>
                <option value="IRR">ریال (پیش‌فرض زرین‌پال)</option>
                <option value="IRT">تومان</option>
              </select>
            </Field>
            <Field
              label="مرچنت کد زرین‌پال"
              hint={config.merchantIdSet ? `کد فعلی ذخیره شده: ${config.merchantIdHint} — برای تغییر کد جدید وارد کنید.` : "هنوز کدی ذخیره نشده؛ در حالت تستی از مرچنت دمو استفاده می‌شود."}
            >
              <input
                name="merchantId"
                className={inputClass}
                dir="ltr"
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            </Field>
            <Field label="نشانی بازگشت (Callback URL)" hint="نشانی کامل صفحهٔ بازگشت پرداخت، مثلاً https://app.example.com/settings/billing">
              <input
                name="callbackUrl"
                className={inputClass}
                dir="ltr"
                defaultValue={config.callbackUrl}
                placeholder="https://app.example.com/settings/billing"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" name="sandbox" defaultChecked={config.sandbox} className="size-4" />
              حالت تست (Sandbox) — پرداخت واقعی انجام نمی‌شود
            </label>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={busy === "config"}>
                {busy === "config" ? <Loader2Icon className="size-4 animate-spin" /> : "ذخیره تنظیمات درگاه"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {canManage && (
        <Card title="بسته‌های شارژ اعتبار">
          <form onSubmit={savePackage} className="mb-4 grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="نام بسته">
              <input name="name" className={inputClass} placeholder="مثلاً بستهٔ ۲۰۰ هزار تومانی" />
            </Field>
            <Field label="قیمت پرداختی (تومان)">
              <PersianNumberInput name="priceToman" className={inputClass} inputMode="numeric" placeholder="200000" />
            </Field>
            <Field label="اعتبار اهدایی (تومان)">
              <PersianNumberInput name="creditToman" className={inputClass} inputMode="numeric" placeholder="220000" />
            </Field>
            <Button type="submit" disabled={busy === "package"}>
              {busy === "package" ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
              افزودن بسته
            </Button>
          </form>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-right text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="py-2 pr-1">نام</th>
                  <th className="py-2">قیمت</th>
                  <th className="py-2">اعتبار</th>
                  <th className="py-2">وضعیت</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody>
                {packages.map((pkg) => (
                  <tr key={pkg.id} className="border-b border-border">
                    <td className="py-2 pr-1 font-medium text-foreground">{pkg.name}</td>
                    <td className="py-2 tabular-nums">{toman(pkg.priceRial)} ت</td>
                    <td className="py-2 tabular-nums">
                      {toman(pkg.creditRial)} ت
                      {pkg.creditRial > pkg.priceRial && (
                        <span className="mr-1 text-xs text-emerald-700 dark:text-emerald-300">
                          (+{toman(pkg.creditRial - pkg.priceRial)})
                        </span>
                      )}
                    </td>
                    <td className="py-2">
                      <button
                        type="button"
                        onClick={() => void togglePackage(pkg)}
                        disabled={busy?.startsWith("pkg")}
                        className={`rounded-full border px-2 py-0.5 text-xs ${
                          pkg.isActive
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                            : "border-border bg-muted text-muted-foreground"
                        }`}
                      >
                        {pkg.isActive ? "فعال" : "غیرفعال"}
                      </button>
                    </td>
                    <td className="py-2 text-left">
                      <button
                        type="button"
                        onClick={() => void deletePackage(pkg.id)}
                        disabled={busy?.startsWith("pkg")}
                        className="text-red-700 dark:text-red-300 hover:text-red-800 dark:hover:text-red-200"
                        aria-label="حذف بسته"
                      >
                        <Trash2Icon className="size-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {packages.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">بسته‌ای تعریف نشده است.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="رسیدهای پرداخت">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          {[
            ["all", "همه"],
            ["pending", "در انتظار"],
            ["verified", "موفق"],
            ["failed", "ناموفق"],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`rounded-full border px-3 py-1 transition ${
                filter === key
                  ? "border-sky-400/50 bg-sky-500/15 text-sky-800 dark:text-sky-200"
                  : "border-border text-muted-foreground hover:bg-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="space-y-2">
          {payments.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {p.businessName ? (
                    <Link href={`/platform/businesses/${p.businessId}/billing`} className="hover:text-sky-700 dark:hover:text-sky-300">
                      {p.businessName}
                    </Link>
                  ) : (
                    "کسب‌وکار"
                  )}
                  <span className="mx-2 text-muted-foreground">·</span>
                  {p.description || STATUS_LABELS[p.status]}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatJalali(p.createdAt, { withMonthName: true, withTime: true })}
                  {p.gatewayRef ? ` · کد پیگیری: ${toPersianDigits(p.gatewayRef)}` : ""}
                  {p.gateway === "manual" ? " · پرداخت دستی" : " · زرین‌پال"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-sm font-semibold tabular-nums">{toman(p.amountRial)} تومان</span>
                {p.status === "verified" ? (
                  <CheckCircle2Icon className="size-5 text-emerald-600 dark:text-emerald-400" />
                ) : p.status === "failed" || p.status === "cancelled" ? (
                  <XCircleIcon className="size-5 text-red-600 dark:text-red-400" />
                ) : canManage ? (
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void review(p.id, "approve")}
                      disabled={busy === `pay-${p.id}`}
                      className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-emerald-500 disabled:opacity-50"
                    >
                      تأیید
                    </button>
                    <button
                      type="button"
                      onClick={() => void review(p.id, "reject")}
                      disabled={busy === `pay-${p.id}`}
                      className="rounded-lg border border-red-500/40 px-2.5 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      رد
                    </button>
                  </span>
                ) : (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
                    {STATUS_LABELS[p.status]}
                  </span>
                )}
              </div>
            </div>
          ))}
          {payments.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">پرداختی در این فهرست نیست.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
