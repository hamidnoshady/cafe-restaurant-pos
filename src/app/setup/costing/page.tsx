"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ErrorBox, errorMessage, InfoBox, PrimaryButton, StepShell } from "../ui";
import { nextPath, skipToPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";

type Method = "fifo" | "weighted_average";

interface CostingResponse {
  costing: { method: Method; lockedAt: string | null } | null;
  locked: boolean;
  error?: string;
}

const OPTIONS: { value: Method; title: string; example: string }[] = [
  {
    value: "fifo",
    title: "اولین صادره از اولین وارده (FIFO)",
    example:
      "مثال: اول ۱۰ کیلو قهوه کیلویی ۵۰۰ هزار تومان خریده‌اید و بعد ۱۰ کیلو کیلویی ۶۰۰ هزار تومان. تا وقتی خرید اول تمام نشده، مصرف با همان کیلویی ۵۰۰ حساب می‌شود و بعد سراغ خرید دوم می‌رود. یعنی بهای مصرف دقیقاً به ترتیب خریدها است.",
  },
  {
    value: "weighted_average",
    title: "میانگین موزون",
    example:
      "مثال: با همان دو خرید، میانگین قیمت می‌شود کیلویی ۵۵۰ هزار تومان و هر مصرفی با همین میانگین حساب می‌شود. یعنی قیمت‌ها با هم مخلوط می‌شوند و محاسبه ساده‌تر است.",
  },
];

export default function CostingStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = stepsFor(industry);
  // Costing (FIFO/weighted-average for inventory_items) is an F&B-only
  // concept -- a jewelry business landing here (a stale link, the back
  // button) belongs at whatever step actually follows it in their flow.
  const available = steps.some((s) => s.id === "costing");
  const [method, setMethod] = useState<Method>("weighted_average");
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!available) {
      router.replace(skipToPath("costing", steps));
      return;
    }
    api<CostingResponse>("/api/setup/costing").then(({ data }) => {
      if (data.costing?.method) setMethod(data.costing.method);
      setLocked(Boolean(data.locked));
    });
  }, [available]);

  if (!available) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (locked) {
      router.push(nextPath("costing"));
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/setup/costing", {
      method: "POST",
      body: JSON.stringify({ method }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    router.push(nextPath("costing"));
  }

  return (
    <StepShell
      step="costing"
      description="مشخص می‌کند بهای تمام‌شدهٔ مواد مصرفی چطور محاسبه شود. بعد از اولین تراکنش انبار این انتخاب قفل می‌شود."
    >
      {locked ? (
        <InfoBox>
          روش قیمت‌گذاری قفل شده است (اولین تراکنش انبار ثبت شده). تغییر آن فقط از طریق فرایند
          رسمی تجدید ارزیابی در فازهای بعدی ممکن است.
        </InfoBox>
      ) : null}
      <form onSubmit={submit} className="max-w-2xl">
        <ErrorBox>{error}</ErrorBox>
        <div className="space-y-3">
          {OPTIONS.map((o) => (
            <label
              key={o.value}
              className={`block cursor-pointer rounded-xl border p-4 transition ${
                method === o.value
                  ? "border-primary bg-primary/5 ring-2 ring-ring/30"
                  : "border-border hover:border-muted-foreground/40"
              } ${locked ? "opacity-70" : ""}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="method"
                  checked={method === o.value}
                  disabled={locked}
                  onChange={() => setMethod(o.value)}
                />
                <span className="font-semibold">{o.title}</span>
              </span>
              <span className="mt-2 block text-sm leading-6 text-muted-foreground">{o.example}</span>
            </label>
          ))}
        </div>
        <div className="mt-6">
          <PrimaryButton disabled={busy}>{locked ? "ادامه" : "انتخاب و ادامه"}</PrimaryButton>
        </div>
      </form>
    </StepShell>
  );
}
