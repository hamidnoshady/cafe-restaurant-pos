"use client";

/**
 * Phase 37 — the business's own view of the gateway.
 *
 * Everything a business is allowed to know about the deployment's model
 * routing, and nothing else: which model its assistant is using right now,
 * and — only if the platform has published a list — the ability to pick a
 * different one from it.
 *
 * The panel hides itself entirely when the platform runs without a gateway.
 * That is the point: a café on a direct OpenRouter or Arvan connection has no
 * model choice to make, and a control that explains a component the
 * deployment does not have is noise on a screen a cashier also looks at.
 */
import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { SectionCard } from "../page-chrome";

interface GatewayInfo {
  available: boolean;
  allowBusinessModels: boolean;
  effectiveModel: string;
  platformModel: string;
  publishedModels: string[];
  modelOverride: string | null;
  hasVirtualKey: boolean;
  syncError: string | null;
  error?: string;
}

export function AiGatewayPanel() {
  const [info, setInfo] = useState<GatewayInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/ai/gateway");
      const body = (await res.json().catch(() => ({}))) as GatewayInfo;
      if (!res.ok) throw new Error(body.error ?? "خواندن تنظیمات مدل ممکن نشد.");
      setInfo(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "خواندن تنظیمات مدل ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function chooseModel(value: string) {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/dashboard/ai/gateway", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelOverride: value === "" ? null : value }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "ذخیرهٔ انتخاب مدل انجام نشد.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ذخیرهٔ انتخاب مدل انجام نشد.");
    } finally {
      setSaving(false);
    }
  }

  // No gateway, no panel: the platform has not enabled one, so there is
  // nothing here for this business to see or change.
  if (loading) return null;
  if (error || !info || !info.available) return null;

  return (
    <SectionCard
      title="مدل دستیار"
      description="مدلی که پاسخ‌های دستیار این کسب‌وکار را می‌نویسد."
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="text-stone-500">مدل فعلی</span>
          <span className="font-medium text-stone-900" dir="ltr">
            {info.effectiveModel}
          </span>
        </div>

        {info.allowBusinessModels && info.publishedModels.length > 0 ? (
          <div className="space-y-1">
            <label className="block text-sm text-stone-600">انتخاب مدل</label>
            <SearchableSelect
              value={info.modelOverride ?? ""}
              onChange={(value) => void chooseModel(value)}
              options={[
                { value: "", label: `پیش‌فرض پلتفرم (${info.platformModel})` },
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

        {info.syncError ? <p className="text-xs text-rose-600">{info.syncError}</p> : null}
        {error ? (
          <div className="flex items-center gap-2 text-sm text-rose-600">
            <span>{error}</span>
            <Button variant="ghost" onClick={() => void load()} disabled={saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : "تلاش دوباره"}
            </Button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
