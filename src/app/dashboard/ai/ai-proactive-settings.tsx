"use client";

import { useEffect, useState } from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";

interface Overview {
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: "completed" | "skipped" | "failed" | null;
  draftCount: number;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const statusLabel: Record<NonNullable<Overview["lastRunStatus"]>, string> = {
  completed: "انجام شد",
  skipped: "رد شد",
  failed: "ناموفق بود",
};

/** A setting, not the Wave 5 digest interface: it makes paid background work explicit. */
export function AiProactiveSettings() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const locked = useFeatureLocked();

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/ai/proactive");
      const body = (await response.json().catch(() => ({}))) as Overview & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "خواندن تنظیمات گزارش‌های خودکار ممکن نشد.");
      setData(body);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "خواندن تنظیمات گزارش‌های خودکار ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (locked) {
      setData({ enabled: false, lastRunAt: null, lastRunStatus: null, draftCount: 0 });
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  async function toggle() {
    if (!data || saving) return;
    setSaving(true);
    try {
      const response = await fetch("/api/ai/proactive", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !data.enabled }),
      });
      const body = (await response.json().catch(() => ({}))) as { enabled?: boolean; error?: string };
      if (!response.ok || typeof body.enabled !== "boolean") {
        throw new Error(body.error ?? "ذخیرهٔ تنظیمات ممکن نشد.");
      }
      setData((current) => (current ? { ...current, enabled: body.enabled! } : current));
      toast.success(body.enabled ? "گزارش‌های خودکار فعال شدند." : "گزارش‌های خودکار متوقف شدند.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ذخیرهٔ تنظیمات ممکن نشد.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <section className="rounded-2xl border bg-card p-5 text-sm text-muted-foreground">
        <Loader2Icon className="me-2 inline size-4 animate-spin" /> در حال خواندن تنظیمات گزارش‌های خودکار…
      </section>
    );
  }
  if (!data) return null;

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xl">
          <h2 className="flex items-center gap-2 font-semibold">
            <SparklesIcon className="size-5 text-primary" /> گزارش‌های خودکار دستیار
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            خلاصهٔ روزانه و هفتگی، هشدارهای عملیاتی و پیش‌نویس‌های پیگیری بدهی در پس‌زمینه آماده می‌شوند. این کار از اعتبار AI شما استفاده می‌کند؛ هیچ پیام مشتری به‌صورت خودکار ارسال نمی‌شود.
          </p>
        </div>
        <Button variant={data.enabled ? "outline" : "default"} onClick={() => void toggle()} disabled={saving} aria-pressed={data.enabled}>
          {saving ? <Loader2Icon className="animate-spin" /> : null}
          {data.enabled ? "غیرفعال‌سازی" : "فعال‌سازی"}
        </Button>
      </div>
      <div className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
        <p>وضعیت: <span className="font-medium text-foreground">{data.enabled ? "فعال" : "غیرفعال"}</span></p>
        <p>
          آخرین اجرا: <span className="font-medium text-foreground">{data.lastRunAt ? `${formatDate(data.lastRunAt)}${data.lastRunStatus ? ` · ${statusLabel[data.lastRunStatus]}` : ""}` : "هنوز اجرا نشده"}</span>
        </p>
        <p>پیش‌نویس‌های آماده: <span className="font-medium text-foreground">{data.draftCount.toLocaleString("fa-IR")}</span></p>
      </div>
    </section>
  );
}
