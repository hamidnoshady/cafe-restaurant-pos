"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2Icon } from "lucide-react";
import type { AiProvider, PublicAiConfig } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

interface ProviderOpt {
  id: AiProvider;
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

const SAVE_ERROR: Record<string, string> = {
  ai_bad_provider: "سرویس انتخابی نامعتبر است.",
  ai_bad_model: "نام مدل را وارد کنید.",
  ai_bad_base_url: "آدرس سرویس باید با http یا https شروع شود.",
  ai_bad_temperature: "دما باید بین ۰ تا ۲ باشد.",
  forbidden: "دسترسی فقط برای مالک و مدیر است.",
};

export function AiSettings() {
  const [providers, setProviders] = useState<ProviderOpt[]>([]);
  const [config, setConfig] = useState<PublicAiConfig | null>(null);
  const [provider, setProvider] = useState<AiProvider>("openrouter");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [temperature, setTemperature] = useState(0.3);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/ai/config")
      .then((r) => r.json())
      .then((data: { config: PublicAiConfig; providers: ProviderOpt[] }) => {
        setProviders(data.providers ?? []);
        const c = data.config;
        if (c) {
          setConfig(c);
          setProvider(c.provider);
          setModel(c.model);
          setBaseUrl(c.baseUrl);
          setTemperature(c.temperature);
          setEnabled(c.enabled);
        }
      })
      .catch(() => toast.error("خواندن تنظیمات ممکن نشد."))
      .finally(() => setLoading(false));
  }, []);

  function onProviderChange(next: AiProvider) {
    setProvider(next);
    const opt = providers.find((p) => p.id === next);
    if (opt) {
      // Reset base URL/model to the new provider's defaults for a clean switch.
      setBaseUrl(opt.defaultBaseUrl);
      setModel(opt.defaultModel);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/ai/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled, provider, model, baseUrl, apiKey, temperature }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(SAVE_ERROR[data.error as string] ?? "ذخیره نشد.");
        return;
      }
      setConfig(data.config);
      setApiKey("");
      toast.success("تنظیمات ذخیره شد.");
    } catch {
      toast.error("خطای شبکه هنگام ذخیره.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> در حال بارگذاری…
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-2xl border bg-card p-5">
      <div className="flex items-center justify-between rounded-xl bg-muted/40 px-4 py-3">
        <div>
          <p className="text-sm font-medium">فعال بودن دستیار</p>
          <p className="text-xs text-muted-foreground">
            وقتی خاموش است، دکمهٔ شناور پیام «تنظیم نشده» می‌دهد.
          </p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <Field label="سرویس هوش مصنوعی">
        <select
          className={inputClass}
          value={provider}
          onChange={(e) => onProviderChange(e.target.value as AiProvider)}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="نام مدل" hint="مثلاً openai/gpt-4o-mini برای OpenRouter.">
        <Input value={model} onChange={(e) => setModel(e.target.value)} dir="ltr" />
      </Field>

      <Field label="آدرس سرویس (Base URL)" hint="نقطهٔ پایانی سازگار با OpenAI؛ در صورت نیاز مطابق پلن خود ویرایش کنید.">
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} dir="ltr" />
      </Field>

      <Field
        label="کلید API"
        hint={
          config?.hasKey
            ? `کلیدی ذخیره شده است${config.keyHint ? ` (…${config.keyHint})` : ""}. برای حفظ آن، این فیلد را خالی بگذارید.`
            : "کلید سرویس را وارد کنید. فقط روی سرور ذخیره می‌شود."
        }
      >
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          dir="ltr"
          placeholder={config?.hasKey ? "••••••••" : "sk-…"}
          autoComplete="off"
        />
      </Field>

      <Field label={`دما (${temperature.toFixed(1)})`} hint="پایین‌تر = پاسخ دقیق‌تر و کم‌ریسک‌تر.">
        <input
          type="range"
          min={0}
          max={1.2}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
          className="w-full accent-primary"
        />
      </Field>

      <div className="flex justify-end pt-2">
        <Button onClick={save} disabled={saving} className="px-5 font-semibold">
          {saving && <Loader2Icon className="animate-spin" />}
          ذخیره
        </Button>
      </div>
    </div>
  );
}
