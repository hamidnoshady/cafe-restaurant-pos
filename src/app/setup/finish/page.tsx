"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { api, ErrorBox, errorMessage, PrimaryButton } from "../ui";
import { stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";

interface StateResponse {
  progress?: { steps: Record<string, string>; completedAt: string | null };
  counts?: { accounts: number; users: number; categories: number; items: number; printers: number };
  missingForCompletion?: string[];
  error?: string;
}

export default function FinishPage() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = stepsFor(industry);
  const [state, setState] = useState<StateResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);

  const load = useCallback(() => {
    api<StateResponse>("/api/setup/state").then(({ data }) => {
      setState(data);
      setCompleted(Boolean(data.progress?.completedAt));
    });
  }, []);
  useEffect(load, [load]);

  async function complete() {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; messages?: string[] }>("/api/setup/complete", {
      method: "POST",
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error, data.messages));
      load();
      return;
    }
    setCompleted(true);
    router.replace("/dashboard/settings");
  }

  const missing = state?.missingForCompletion ?? [];

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-xl font-bold">پایان راه‌اندازی</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          مرور وضعیت مراحل و تکمیل نهایی — بعد از این، سیستم آمادهٔ ثبت سفارش است.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>

      {completed ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950 p-6 text-center">
          <p className="mb-2 text-2xl">🎉</p>
          <p className="mb-1 font-bold text-emerald-800 dark:text-emerald-200">راه‌اندازی کامل شد!</p>
          <p className="mb-4 text-sm text-emerald-700 dark:text-emerald-300">
            کسب‌وکار شما آمادهٔ ثبت سفارش است. امکانات فروش در فاز ۲ فعال می‌شود.
          </p>
          <Link
            href="/dashboard"
            className="inline-block rounded-lg bg-emerald-700 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            رفتن به داشبورد
          </Link>
        </div>
      ) : (
        <>
          <ul className="mb-6 divide-y divide-border rounded-xl border border-border">
            {steps.map((s) => {
              const done = Boolean(state?.progress?.steps[s.id]);
              return (
                <li key={s.id} className="flex items-center justify-between px-4 py-3 text-sm">
                  <span className="flex items-center gap-2">
                    <span
                      className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                        done ? "bg-emerald-700 text-white dark:bg-emerald-600" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {done ? "✓" : "•"}
                    </span>
                    {s.title}
                    {s.optional ? <span className="text-xs text-muted-foreground">(اختیاری)</span> : null}
                  </span>
                  <Link href={s.path} className="text-xs text-primary hover:underline">
                    {done ? "ویرایش" : "تکمیل"}
                  </Link>
                </li>
              );
            })}
          </ul>

          {state?.counts ? (
            <p className="mb-6 text-sm text-muted-foreground">
              {toPersianDigits(state.counts.accounts)} حساب، {toPersianDigits(state.counts.users)} کاربر
              {industry === "food_service" ? (
                <>
                  ، {toPersianDigits(state.counts.categories)} دستهٔ منو، {toPersianDigits(state.counts.items)} آیتم
                </>
              ) : null}
              ، {toPersianDigits(state.counts.printers)} چاپگر ثبت شده است.
            </p>
          ) : null}

          {missing.length > 0 ? (
            <div className="mb-6 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm text-primary">
              <p className="mb-1 font-semibold">برای تکمیل، این موارد باقی مانده‌اند:</p>
              {missing.map((m, i) => (
                <p key={i}>• {m}</p>
              ))}
            </div>
          ) : null}

          <PrimaryButton type="button" onClick={complete} disabled={busy || missing.length > 0}>
            تکمیل راه‌اندازی
          </PrimaryButton>
        </>
      )}
    </div>
  );
}
