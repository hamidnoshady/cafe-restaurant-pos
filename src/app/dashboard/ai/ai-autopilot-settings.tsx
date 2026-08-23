"use client";

import { useEffect, useState } from "react";
import { Loader2Icon, LockIcon, WandSparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import { AUTOPILOT_CATEGORIES, AUTOPILOT_CATEGORY_LABELS, type AutopilotCategory } from "@/lib/ai-autopilot";
import { moneyToInput, moneyFromInput } from "@/lib/money";

interface Setting {
  enabled: boolean;
  maxAmountRial: number | null;
  maxPercent: number | null;
  maxItemsPerRun: number;
  dailyActionLimit: number;
}

interface Payload {
  settings: Record<AutopilotCategory, Setting>;
  ceilings: Record<AutopilotCategory, Setting>;
  canEnableMoney: boolean;
}

/**
 * What each category will and will not do, unattended. The two fixed
 * boundaries below are permanent product copy, not fine print: no setting on
 * this page can turn them off.
 */
const DESCRIPTIONS: Record<AutopilotCategory, string> = {
  inventory:
    "کسری‌های زیر نقطهٔ سفارش را می‌بیند و پیش‌نویس سفارش خرید یا تعدیل شمارش ثبت می‌کند. هر دو قابل بازگرداندن‌اند.",
  pricing:
    "وقتی بهای مواد دستور ثبت‌شده جابه‌جا شده باشد، قیمت آیتم را اصلاح یا آیتم را غیرفعال می‌کند. قیمت قبلی نگه داشته می‌شود.",
  money:
    "تخفیف روی سفارش باز، دسته‌بندی هزینه و پیش‌نویس سند حسابداری. «سند حسابداری فقط به‌صورت پیش‌نویس در صف تأیید ثبت می‌شود و هرگز خودکار به دفتر نمی‌رود.»",
  customer:
    "یادداشت داخلی روی پروندهٔ مشتری. «فقط یادداشت داخلی ثبت می‌شود؛ هیچ پیامی برای مشتری ارسال نمی‌شود.»",
  waste:
    "الگوی ضایعات و اقلام با حاشیهٔ منفی را بررسی و گزارش می‌کند. «فقط شناسایی و هشدار — ثبت ضایعات همیشه دستی است، چون دلیل خروج کالا را فقط انسان می‌داند.»",
};

function NumberField({
  label,
  hint,
  value,
  max,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: number;
  max: number;
  onChange: (next: number) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="number"
        dir="ltr"
        min={1}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-lg border bg-background px-2 py-1.5 text-left text-sm disabled:opacity-50"
      />
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function AiAutopilotSettings() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCategory, setSavingCategory] = useState<AutopilotCategory | null>(null);
  const locked = useFeatureLocked();

  useEffect(() => {
    if (locked) {
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        const response = await fetch("/api/ai/autopilot");
        const body = (await response.json().catch(() => ({}))) as Payload & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "خواندن تنظیمات اجرای خودکار ممکن نشد.");
        setData(body);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "خواندن تنظیمات اجرای خودکار ممکن نشد.");
      } finally {
        setLoading(false);
      }
    })();
  }, [locked]);

  async function save(category: AutopilotCategory, next: Setting) {
    if (savingCategory) return;
    setSavingCategory(category);
    try {
      const response = await fetch("/api/ai/autopilot", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, ...next }),
      });
      const body = (await response.json().catch(() => ({}))) as { setting?: Setting; error?: string };
      if (!response.ok || !body.setting) {
        throw new Error(
          body.error === "owner_required"
            ? "فعال‌سازی اجرای خودکار مالی فقط با نقش «مالک» ممکن است."
            : body.error ?? "ذخیرهٔ تنظیمات ممکن نشد.",
        );
      }
      // The server clamps to its own ceiling, so the saved value is the truth.
      setData((current) =>
        current ? { ...current, settings: { ...current.settings, [category]: body.setting! } } : current,
      );
      toast.success("تنظیمات ذخیره شد.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ذخیرهٔ تنظیمات ممکن نشد.");
    } finally {
      setSavingCategory(null);
    }
  }

  if (loading) {
    return (
      <section className="rounded-2xl border bg-card p-5 text-sm text-muted-foreground">
        <Loader2Icon className="me-2 inline size-4 animate-spin" /> در حال خواندن تنظیمات اجرای خودکار…
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="rounded-2xl border bg-card p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <WandSparklesIcon className="size-5 text-primary" /> اجرای خودکار (خلبان خودکار)
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        برای هر دسته جداگانه تعیین کنید که دستیار اجازهٔ اجرای بدون تأیید داشته باشد یا نه. هر پیشنهادی که از سقف
        تعیین‌شدهٔ شما بگذرد، اجرا نمی‌شود و برای تأیید دستی نگه داشته می‌شود — هیچ‌چیز بی‌صدا حذف نمی‌شود. این کار
        فقط زمانی انجام می‌شود که «گزارش‌های خودکار» بالا فعال باشد.
      </p>

      <div className="mt-4 space-y-3">
        {AUTOPILOT_CATEGORIES.map((category) => {
          const setting = data.settings[category];
          const ceiling = data.ceilings[category];
          const ownerOnly = category === "money" && !data.canEnableMoney;
          const busy = savingCategory === category;
          const update = (patch: Partial<Setting>) => void save(category, { ...setting, ...patch });

          return (
            <div key={category} className="rounded-xl border p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="max-w-xl">
                  <h3 className="text-sm font-semibold">{AUTOPILOT_CATEGORY_LABELS[category]}</h3>
                  <p className="mt-1 text-xs leading-6 text-muted-foreground">{DESCRIPTIONS[category]}</p>
                </div>
                <Button
                  size="sm"
                  variant={setting.enabled ? "outline" : "default"}
                  disabled={busy || (ownerOnly && !setting.enabled)}
                  aria-pressed={setting.enabled}
                  onClick={() => update({ enabled: !setting.enabled })}
                >
                  {busy ? <Loader2Icon className="animate-spin" /> : ownerOnly && !setting.enabled ? <LockIcon /> : null}
                  {setting.enabled ? "غیرفعال‌سازی" : "فعال‌سازی"}
                </Button>
              </div>

              {ownerOnly && !setting.enabled ? (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  فعال‌سازی این دسته فقط با نقش «مالک» ممکن است؛ مدیر می‌تواند سقف‌ها را کمتر کند.
                </p>
              ) : null}

              {setting.enabled ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  {ceiling.maxAmountRial !== null ? (
                    <NumberField
                      label="حداکثر مبلغ (تومان)"
                      hint={`سقف مجاز: ${moneyToInput(ceiling.maxAmountRial, "toman").toLocaleString("fa-IR")}`}
                      value={moneyToInput(setting.maxAmountRial ?? ceiling.maxAmountRial, "toman")}
                      max={moneyToInput(ceiling.maxAmountRial, "toman")}
                      disabled={busy}
                      onChange={(next) => update({ maxAmountRial: moneyFromInput(next, "toman") })}
                    />
                  ) : null}
                  {ceiling.maxPercent !== null ? (
                    <NumberField
                      label="حداکثر درصد"
                      hint={`سقف مجاز: ${ceiling.maxPercent.toLocaleString("fa-IR")}٪`}
                      value={setting.maxPercent ?? ceiling.maxPercent}
                      max={ceiling.maxPercent}
                      disabled={busy}
                      onChange={(next) => update({ maxPercent: next })}
                    />
                  ) : null}
                  <NumberField
                    label="حداکثر اقلام در هر اجرا"
                    value={setting.maxItemsPerRun}
                    max={ceiling.maxItemsPerRun}
                    disabled={busy}
                    onChange={(next) => update({ maxItemsPerRun: next })}
                  />
                  <NumberField
                    label="حداکثر اجرا در شبانه‌روز"
                    value={setting.dailyActionLimit}
                    max={ceiling.dailyActionLimit}
                    disabled={busy}
                    onChange={(next) => update({ dailyActionLimit: next })}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
