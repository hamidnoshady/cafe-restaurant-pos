"use client";

/**
 * Meters, spend limits and commercial rules. Technical provider settings
 * stay in their own consoles.
 */
import { useState } from "react";
import { usePlatformQuery } from "../../_lib/use-platform-data";
import { Card, EmptyState, ErrorBox, SkeletonRows } from "../../ui";
import { formatRial } from "@/lib/platform-money";
import { platformFetch } from "@/lib/platform-client";

interface MeterRow {
  key: string;
  name: string;
  unit: string;
  aggregation: string;
  source: string;
  customerVisible: boolean;
  critical: boolean;
  price: { version: number; unitAmountRial: number; unit: string } | null;
}

export function BillingMetersTab() {
  const query = usePlatformQuery<{ meters: MeterRow[] }>("/api/platform/billing/meters");
  if (query.loading) return <SkeletonRows rows={6} />;
  if (query.errorText) return <ErrorBox>{query.errorText}</ErrorBox>;
  const meters = query.data?.meters ?? [];
  if (meters.length === 0) return <EmptyState title="کنتوری ثبت نشده است" />;
  return (
    <Card title="کنتورها">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-2 text-right font-medium">نام</th>
              <th className="py-2 text-right font-medium">کلید</th>
              <th className="py-2 text-right font-medium">واحد</th>
              <th className="py-2 text-right font-medium">تجمیع</th>
              <th className="py-2 text-left font-medium">قیمت باز</th>
            </tr>
          </thead>
          <tbody>
            {meters.map((meter) => (
              <tr key={meter.key} className="border-t border-border">
                <td className="py-2">{meter.name}</td>
                <td className="py-2 font-mono text-xs text-muted-foreground" dir="ltr">{meter.key}</td>
                <td className="py-2" dir="ltr">{meter.unit}</td>
                <td className="py-2">{meter.aggregation}</td>
                <td className="py-2 text-left tabular-nums">
                  {meter.price ? formatRial(meter.price.unitAmountRial) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function BillingRulesTab() {
  const query = usePlatformQuery<{ settings: Record<string, unknown> }>("/api/platform/billing/settings");
  const [footer, setFooter] = useState("");
  const [message, setMessage] = useState("");
  if (query.loading) return <SkeletonRows rows={4} />;
  if (query.errorText) return <ErrorBox>{query.errorText}</ErrorBox>;
  const settings = query.data?.settings ?? {};
  return (
    <Card title="قواعد تجاری">
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <Setting label="پیشوند فاکتور" value={String(settings.invoice_prefix ?? "")} />
        <Setting label="مهلت پرداخت (روز)" value={String(settings.default_due_days ?? "")} />
        <Setting label="مهلت ارفاق (روز)" value={String(settings.default_grace_days ?? "")} />
        <Setting label="گرد کردن" value={String(settings.rounding ?? "")} />
        <Setting label="حداقل شارژ (ریال)" value={String(settings.minimum_top_up_rial ?? "")} />
        <Setting label="سیاست اضافه مصرف" value={String(settings.overage_policy ?? "")} />
        <Setting label="عمل پیش‌فرض سقف هزینه" value={String(settings.default_spend_action ?? "")} />
        <Setting label="مالیات (ده‌هزارم)" value={String(settings.tax_rate_bps ?? "")} />
      </dl>
      <form
        className="mt-4 space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void platformFetch("/api/platform/billing/settings", {
            method: "PUT",
            body: { invoiceFooter: footer },
          }).then((result) => {
            setMessage(result.ok ? "ذخیره شد." : "ذخیره نشد.");
            if (result.ok) query.refetch();
          });
        }}
      >
        <label className="block text-sm">
          متن پایین فاکتور
          <textarea
            className="mt-1 w-full rounded-lg border border-border bg-card p-2 text-sm"
            rows={3}
            value={footer}
            onChange={(event) => setFooter(event.target.value)}
          />
        </label>
        <button type="submit" className="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white">
          ذخیرهٔ متن
        </button>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </form>
    </Card>
  );
}

export function BillingSpendTab() {
  const [businessId, setBusinessId] = useState("");
  const [budget, setBudget] = useState("");
  const [action, setAction] = useState("warn_only");
  const [message, setMessage] = useState("");
  return (
    <Card title="سقف هزینهٔ یک کسب‌وکار">
      <form
        className="space-y-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          const monthlyBudgetRial = budget.trim() === "" ? null : Math.floor(Number(budget));
          void platformFetch("/api/platform/billing/spend", {
            method: "PUT",
            body: { businessId: businessId.trim(), monthlyBudgetRial, actionAtLimit: action },
          }).then((result) => setMessage(result.ok ? "سیاست ذخیره شد." : "ذخیره نشد."));
        }}
      >
        <label className="block">
          شناسهٔ کسب‌وکار
          <input
            className="mt-1 w-full rounded-lg border border-border bg-card p-2 font-mono text-xs"
            dir="ltr"
            value={businessId}
            onChange={(event) => setBusinessId(event.target.value)}
            required
          />
        </label>
        <label className="block">
          بودجهٔ ماهانه (ریال)
          <input
            className="mt-1 w-full rounded-lg border border-border bg-card p-2 tabular-nums"
            dir="ltr"
            inputMode="numeric"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
        </label>
        <label className="block">
          عمل در رسیدن به سقف
          <select
            className="mt-1 w-full rounded-lg border border-border bg-card p-2"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="continue">ادامه</option>
            <option value="warn_only">فقط هشدار</option>
            <option value="block_noncritical">توقف کارهای غیرحیاتی</option>
            <option value="throttle_noncritical">کند کردن کارهای غیرحیاتی</option>
          </select>
        </label>
        <button type="submit" className="rounded-lg bg-sky-600 px-3 py-2 text-sm text-white">
          ذخیره
        </button>
        {message && <p className="text-muted-foreground">{message}</p>}
      </form>
    </Card>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums" dir="ltr">{value || "—"}</dd>
    </div>
  );
}
