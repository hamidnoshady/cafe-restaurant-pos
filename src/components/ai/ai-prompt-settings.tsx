"use client";

/**
 * The prompt manager's business layer (Phase: prompt manager). A business
 * manager writes standing instructions per assistant surface — how the
 * assistant should talk about *this* café, what to always mention, how to
 * behave on the floor. Instructions are appended to the platform prompt, so
 * the confirm-before-write rules and tool contract cannot be edited away from
 * here — the business shapes its assistant; it does not re-author it.
 */

import { useEffect, useState } from "react";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { inputClass } from "@/app/dashboard/ui";

type Surface = "dashboard" | "floor" | "wizard";

interface Override {
  surface: Surface;
  instructions: string;
  updatedAt: string | null;
}

const SURFACE_LABELS: Record<Surface, { title: string; hint: string }> = {
  dashboard: {
    title: "دستیار داشبورد (مدیر/مالک)",
    hint: "مثلاً: «مبالغ را همیشه به تومان و با مقایسهٔ هفتهٔ قبل بگو» یا «نام شعبهٔ مرکز را همیشه «مرکز» بنویس».",
  },
  floor: {
    title: "دستیار سالن (صندوق‌دار/گارسون)",
    hint: "مثلاً: «در پاسخ‌های غذا، همیشه به آلرژی گلوتن هم اشاره کن».",
  },
  wizard: {
    title: "دستیار راه‌اندازی اولیه",
    hint: "مثلاً: «ما کافه هستیم؛ منو را برای کافه پیشنهاد بده، نه رستوران.»",
  },
};

export function AiPromptSettings() {
  const [drafts, setDrafts] = useState<Record<Surface, string>>({
    dashboard: "",
    floor: "",
    wizard: "",
  });
  const [saved, setSaved] = useState<Record<Surface, boolean>>({
    dashboard: false,
    floor: false,
    wizard: false,
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/prompts");
        const body = (await res.json().catch(() => ({}))) as { overrides?: Override[] };
        if (!res.ok || !body.overrides) throw new Error();
        if (cancelled) return;
        setDrafts((current) => ({
          ...current,
          ...Object.fromEntries(body.overrides!.map((o) => [o.surface, o.instructions])),
        }));
        setSaved(
          Object.fromEntries(
            body.overrides!.map((o) => [o.surface, true]),
          ) as Record<Surface, boolean>,
        );
      } catch {
        if (!cancelled) toast.error("خواندن دستورالعمل‌های دستیار ممکن نشد.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(surface: Surface) {
    const instructions = drafts[surface].trim();
    if (!instructions) {
      toast.error("متن دستورالعمل خالی است؛ برای حذف از دکمهٔ حذف استفاده کنید.");
      return;
    }
    setBusy(surface);
    try {
      const res = await fetch("/api/prompts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surface, instructions }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "save_failed");
      toast.success("دستورالعمل ذخیره شد و از پاسخ بعدی دستیار اعمال می‌شود.");
      setSaved((current) => ({ ...current, [surface]: true }));
    } catch {
      toast.error("ذخیرهٔ دستورالعمل ممکن نشد.");
    } finally {
      setBusy("");
    }
  }

  async function remove(surface: Surface) {
    setBusy(surface + ":remove");
    try {
      const res = await fetch(`/api/prompts?surface=${surface}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      toast.success("دستورالعمل حذف شد؛ دستیار به رفتار پیش‌فرض پلتفرم بازمی‌گردد.");
      setDrafts((current) => ({ ...current, [surface]: "" }));
      setSaved((current) => ({ ...current, [surface]: false }));
    } catch {
      toast.error("حذف دستورالعمل ممکن نشد.");
    } finally {
      setBusy("");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> در حال بارگذاری دستورالعمل‌ها…
      </div>
    );
  }

  return (
    <SectionCard
      title="مدیریت پرامپت دستیار"
      description="دستورالعمل دائمی هر سطح از دستیارِ همین کسب‌وکار. این متن‌ها کنار پرامپت اصلی پلتفرم اعمال می‌شوند و قواعد ایمنی (تأیید پیش از هر تغییر) را نمی‌توانند دور بزنند."
    >
      <div className="space-y-5">
        {(Object.keys(SURFACE_LABELS) as Surface[]).map((surface) => (
          <div key={surface} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor={`prompt-${surface}`} className="text-sm font-medium">
                {SURFACE_LABELS[surface].title}
              </label>
              {saved[surface] ? (
                <span className="text-[11px] text-emerald-600 dark:text-emerald-300">فعال</span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{SURFACE_LABELS[surface].hint}</p>
            <textarea
              id={`prompt-${surface}`}
              className={`${inputClass} min-h-28 leading-7`}
              dir="rtl"
              maxLength={4000}
              value={drafts[surface]}
              placeholder="خالی = بدون دستورالعمل ویژهٔ این کسب‌وکار"
              onChange={(event) =>
                setDrafts((current) => ({ ...current, [surface]: event.target.value }))
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void save(surface)} disabled={Boolean(busy)}>
                {busy === surface ? <Loader2Icon className="animate-spin" /> : null}
                ذخیره
              </Button>
              {saved[surface] ? (
                <Button
                  variant="ghost"
                  onClick={() => void remove(surface)}
                  disabled={Boolean(busy)}
                >
                  {busy === surface + ":remove" ? <Loader2Icon className="animate-spin" /> : null}
                  حذف
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
