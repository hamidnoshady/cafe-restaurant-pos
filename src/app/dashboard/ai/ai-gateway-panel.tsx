"use client";

/**
 * Phase 37 & Phase 39 — the business and branch view of the AI Gateway.
 *
 * Allows viewing effective model per branch or for the entire business,
 * and setting model overrides per branch when permitted.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { SectionCard } from "../page-chrome";

interface GatewayUsageRow {
  day: string;
  model: string;
  spendUsd: number;
  spendRial: number | null;
  promptTokens: number;
  completionTokens: number;
  apiRequests: number;
}

interface LocationOption {
  id: string;
  name: string;
}

interface GatewayInfo {
  available: boolean;
  allowBusinessModels: boolean;
  effectiveModel: string;
  platformModel: string;
  publishedModels: string[];
  modelOverride: string | null;
  businessModelOverride: string | null;
  branchModelOverride: string | null;
  hasVirtualKey: boolean;
  syncError: string | null;
  usage?: GatewayUsageRow[];
  locations?: LocationOption[];
  selectedLocationId?: string | null;
  error?: string;
}

export function AiGatewayPanel() {
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [selectedLocationId, setSelectedLocationId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (locId?: string) => {
    setLoading(true);
    try {
      const url = locId ? `/api/dashboard/ai/gateway?locationId=${encodeURIComponent(locId)}` : "/api/dashboard/ai/gateway";
      const res = await fetch(url);
      const body = (await res.json().catch(() => ({}))) as GatewayInfo;
      if (!res.ok) throw new Error(body.error ?? "خواندن تنظیمات مدل ممکن نشد.");
      setInfo(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "خواندن تنظیمات مدل ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(selectedLocationId);
  }, [load, selectedLocationId]);

  async function chooseModel(value: string) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard/ai/gateway", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelOverride: value === "" ? null : value,
          locationId: selectedLocationId || null,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "ذخیرهٔ انتخاب مدل انجام نشد.");
      await load(selectedLocationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "ذخیرهٔ انتخاب مدل انجام نشد.");
    } finally {
      setSaving(false);
    }
  }

  if (loading && !info) return null;
  if (error || !info || !info.available) return null;

  const locations = info.locations ?? [];

  return (
    <SectionCard
      title="مدل دستیار هوشمند"
      description="مدلی که پاسخ‌های دستیار هوشمند این کسب‌وکار و شعبه‌ها را می‌نویسد."
    >
      <div className="space-y-4">
        {locations.length > 1 ? (
          <div className="space-y-1">
            <label className="block text-sm font-medium text-stone-700">شعبه</label>
            <SearchableSelect
              value={selectedLocationId}
              onChange={(value) => {
                setSelectedLocationId(value);
              }}
              options={[
                { value: "", label: "کل کسب‌وکار (پیش‌فرض)" },
                ...locations.map((loc) => ({ value: loc.id, label: loc.name })),
              ]}
            />
          </div>
        ) : null}

        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm rounded-lg border border-stone-200 bg-stone-50 p-3">
          <span className="text-stone-500">
            {selectedLocationId ? "مدل مؤثر برای این شعبه" : "مدل مؤثر برای کسب‌وکار"}
          </span>
          <span className="font-medium text-stone-900" dir="ltr">
            {info.effectiveModel}
          </span>
        </div>

        {info.allowBusinessModels && info.publishedModels.length > 0 ? (
          <div className="space-y-1">
            <label className="block text-sm text-stone-600">
              {selectedLocationId ? "انتخاب مدل اختصاصی این شعبه" : "انتخاب مدل اختصاصی کسب‌وکار"}
            </label>
            <SearchableSelect
              value={info.modelOverride ?? ""}
              onChange={(value) => void chooseModel(value)}
              options={[
                {
                  value: "",
                  label: selectedLocationId
                    ? `ارث‌بری از کسب‌وکار (${info.businessModelOverride || info.platformModel})`
                    : `پیش‌فرض پلتفرم (${info.platformModel})`,
                },
                ...info.publishedModels.map((model) => ({ value: model, label: model })),
              ]}
            />
            <p className="text-xs text-stone-500">
              فقط مدل‌هایی که پلتفرم منتشر کرده قابل انتخاب‌اند؛ هزینهٔ هر کدام در اعتبار شما محاسبه می‌شود.
            </p>
          </div>
        ) : (
          <p className="text-xs text-stone-500">
            این مدل را پلتفرم تعیین می‌کند. برای تغییر آن با پشتیبانی تماس بگیرید.
          </p>
        )}

        {info.usage && info.usage.length > 0 ? (
          <div className="space-y-1 border-t border-stone-200 pt-3">
            <p className="text-sm text-stone-600">مصرف دستیار در ۳۰ روز گذشته</p>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="text-stone-500">
                  <tr>
                    <th className="px-2 py-1 font-medium">روز</th>
                    <th className="px-2 py-1 font-medium">درخواست</th>
                    <th className="px-2 py-1 font-medium">توکن ورودی/خروجی</th>
                    <th className="px-2 py-1 font-medium">هزینهٔ مصرف</th>
                  </tr>
                </thead>
                <tbody>
                  {info.usage.slice(0, 15).map((row) => (
                    <tr key={`${row.day}|${row.model}`} className="border-t border-stone-100">
                      <td className="px-2 py-1" dir="ltr">{row.day}</td>
                      <td className="px-2 py-1">{new Intl.NumberFormat("fa-IR").format(row.apiRequests)}</td>
                      <td className="px-2 py-1">
                        {new Intl.NumberFormat("fa-IR").format(row.promptTokens)} /{" "}
                        {new Intl.NumberFormat("fa-IR").format(row.completionTokens)}
                      </td>
                      <td className="px-2 py-1">
                        {row.spendRial !== null
                          ? `${new Intl.NumberFormat("fa-IR").format(row.spendRial)} ریال`
                          : `${new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 6 }).format(row.spendUsd)} دلار`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-stone-500">
              گزارش مصرف دروازه برای شفافیت است؛ مبلغ کسرشده از اعتبار شما همان است که در دفتر اعتبار
              هوش مصنوعی می‌بینید.
            </p>
          </div>
        ) : null}

        {info.syncError ? <p className="text-xs text-rose-600">{info.syncError}</p> : null}
        {error ? (
          <div className="flex items-center gap-2 text-sm text-rose-600">
            <span>{error}</span>
            <Button variant="ghost" onClick={() => void load(selectedLocationId)} disabled={saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : "تلاش دوباره"}
            </Button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
