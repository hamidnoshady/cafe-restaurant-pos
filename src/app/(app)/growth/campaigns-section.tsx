"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The Growth app's campaigns section (Phase 36b).
 *
 * The promotion engine is unchanged — one deterministic engine
 * (`src/lib/promotions.ts`) feeding both the F&B order path and the retail
 * invoice path. What this section adds around it is the management half the
 * old flat page never had: every campaign labelled with where it is in its
 * life («در حال اجرا» / «زمان‌بندی‌شده» / «پایان‌یافته» / «متوقف»), one-tap
 * pause/resume, and the effectiveness report — how often each campaign fired
 * and what it cost — sitting next to the form that creates the next one.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { classifyCampaign, rollingWindow, type CampaignState } from "@/lib/growth-shared";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { CampaignAudiencePanel } from "./campaign-audience-panel";
import { api, ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";

interface PromotionRow {
  id: string;
  name: string;
  kind: "percent" | "amount" | "bundle_price" | "buy_x_get_y";
  value: number;
  minQuantity: number | null;
  itemIds: string[];
  brandIds: string[];
  categoryIds: string[];
  activeFrom: string | null;
  activeTo: string | null;
  daysOfWeek: number[];
  timeFrom: string | null;
  timeTo: string | null;
  priority: number;
  stacking: "exclusive" | "stackable";
  isActive: boolean;
}

interface EffectivenessRow {
  promotionId: string;
  promotionName: string;
  applications: number;
  totalDiscountRial: number;
}

const KIND_LABELS: Record<PromotionRow["kind"], string> = {
  percent: "درصدی",
  amount: "مبلغ ثابت",
  bundle_price: "ست هدیه (قیمت کل)",
  buy_x_get_y: "تعداد مشخص با قیمت ثابت",
};

const STATE_LABELS: Record<CampaignState, string> = {
  live: "در حال اجرا",
  scheduled: "زمان‌بندی‌شده",
  ended: "پایان‌یافته",
  paused: "متوقف",
};

function stateTone(state: CampaignState): "active" | "positive" | "neutral" | "danger" {
  if (state === "live") return "active";
  if (state === "scheduled") return "positive";
  return "neutral";
}

export function CampaignsSection() {
  const money = useMoney();
  const [promotions, setPromotions] = useState<PromotionRow[] | null>(null);
  const [effect, setEffect] = useState<EffectivenessRow[] | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    api<{ promotions: PromotionRow[] }>("/api/promotions").then(({ ok, data }) => ok && setPromotions(data.promotions));
    // The effectiveness report over the same rolling window the dashboard's
    // KPIs use, so the two screens never disagree about "last month".
    const { from, to } = rollingWindow(new Date().toISOString().slice(0, 10));
    api<{ rows: EffectivenessRow[] }>(`/api/promotions/reports?from=${from}&to=${to}`).then(({ ok, data }) => {
      if (ok) setEffect(data.rows);
    });
  }, []);
  useEffect(load, [load]);

  const today = new Date().toISOString().slice(0, 10);

  async function toggle(promotion: PromotionRow) {
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/promotions", {
      method: "POST",
      body: JSON.stringify({ ...promotion, isActive: !promotion.isActive }),
    });
    if (!ok) {
      setError(data.message ?? "تغییر وضعیت کمپین ناموفق بود.");
      return;
    }
    setDone(promotion.isActive ? "کمپین متوقف شد." : "کمپین فعال شد.");
    load();
  }

  if (!promotions) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  const states = promotions.map((p) => classifyCampaign(p, today));
  const counts: Record<CampaignState, number> = { live: 0, scheduled: 0, ended: 0, paused: 0 };
  for (const state of states) counts[state] += 1;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}

      {/*
        Phase 36d — who a campaign reaches, from the CRM's segments, sitting
        next to the form that creates the campaign. Placed above the promotion
        list because audience is the question an owner asks first.
      */}
      <CampaignAudiencePanel />

      <div className="grid gap-4 lg:grid-cols-2">
        <PromotionForm
          onSaved={(m) => {
            setDone(m);
            load();
          }}
          onError={setError}
        />
        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">اثربخشی کمپین</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">اثربخشی کمپین‌ها</h2>
            </div>
          }
          description="چند بار هر کمپین روی فروش اعمال شد و چقدر تخفیف داد — ۳۰ روز گذشته"
        >
          {!effect || effect.length === 0 ? (
            <EmptyState>هنوز کمپینی روی فروشی اعمال نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 text-sm">
              {effect.map((row) => (
                <li key={row.promotionId} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="font-medium text-foreground">{row.promotionName}</span>
                    <span className="mr-2 text-xs text-muted-foreground">
                      {formatPersianNumber(row.applications)} بار اعمال
                    </span>
                  </div>
                  <span className="shrink-0 font-semibold text-amber-700 dark:text-amber-300">{money.format(row.totalDiscountRial)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            تخفیف کمپین همان‌جا در سند فروش می‌نشیند که خط تخفیف‌خورده ثبت می‌شود؛ این گزارش فقط همان اعداد را
            جمع می‌زند، حساب دیگری باز نمی‌کند.
          </p>
        </SectionCard>
      </div>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت کمپین‌ها</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">کمپین‌ها</h2>
          </div>
        }
        description={`${formatPersianNumber(counts.live)} در حال اجرا · ${formatPersianNumber(counts.scheduled)} زمان‌بندی‌شده · ${formatPersianNumber(counts.paused)} متوقف · ${formatPersianNumber(counts.ended)} پایان‌یافته`}
      >
        {promotions.length === 0 ? (
          <EmptyState>هنوز کمپینی تعریف نشده است.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {promotions.map((p, i) => {
              const state = states[i];
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="leading-6">
                      <span className="font-medium text-foreground">{p.name}</span>{" "}
                      <StatusBadge tone={stateTone(state)}>{STATE_LABELS[state]}</StatusBadge>
                    </p>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {KIND_LABELS[p.kind]} · {p.kind === "percent" ? `${formatPersianNumber(p.value)}٪` : money.format(p.value)} ·
                      اولویت {formatPersianNumber(p.priority)} · {p.stacking === "exclusive" ? "انحصاری" : "ترکیب‌پذیر"}
                      {(p.activeFrom || p.activeTo) && (
                        <>
                          {" · "}
                          {p.activeFrom ? toPersianDigits(formatJalali(p.activeFrom)) : "…"} تا{" "}
                          {p.activeTo ? toPersianDigits(formatJalali(p.activeTo)) : "…"}
                        </>
                      )}
                      {(p.timeFrom || p.timeTo) && <> · {toPersianDigits(p.timeFrom ?? "…")} تا {toPersianDigits(p.timeTo ?? "…")}</>}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" disabled={state === "ended"} onClick={() => void toggle(p)}>
                    {p.isActive ? "توقف" : "فعال‌سازی"}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

function PromotionForm({ onSaved, onError }: { onSaved: (m: string) => void; onError: (m: string) => void }) {
  const money = useMoney();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("percent");
  const [value, setValue] = useState("");
  const [minQuantity, setMinQuantity] = useState("");
  const [priority, setPriority] = useState("0");
  const [stacking, setStacking] = useState("exclusive");
  const [activeFrom, setActiveFrom] = useState("");
  const [activeTo, setActiveTo] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/promotions", {
      method: "POST",
      body: JSON.stringify({
        name,
        kind,
        value: kind === "percent" ? Number(value) : money.parse(value),
        minQuantity: minQuantity.trim() ? Number(minQuantity) : null,
        priority: Number(priority) || 0,
        stacking,
        activeFrom: activeFrom || null,
        activeTo: activeTo || null,
        timeFrom: timeFrom || null,
        timeTo: timeTo || null,
      }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "ثبت کمپین ناموفق بود.");
    else {
      setName("");
      setValue("");
      setMinQuantity("");
      onSaved("کمپین ذخیره شد.");
    }
  }

  return (
    <SectionCard title="کمپین جدید" bodyClassName="space-y-3 p-4 sm:p-5">
      <form onSubmit={submit} className="grid gap-3">
        <Field label="نام کمپین">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="نوع">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={kind === "percent" ? "درصد" : `مبلغ (${money.unitLabel})`}>
            <PersianNumberInput
              inputMode={kind === "percent" ? "decimal" : "numeric"}
              className={inputClass}
              dir="ltr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
        </div>
        {kind === "buy_x_get_y" ? (
          <Field label="حداقل تعداد برای قیمت ثابت">
            <PersianNumberInput
              inputMode="decimal"
              className={inputClass}
              dir="ltr"
              value={minQuantity}
              onChange={(e) => setMinQuantity(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="اولویت (بیشتر = زودتر)">
            <PersianNumberInput
              inputMode="numeric"
              className={inputClass}
              dir="ltr"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </Field>
          <Field label="قانون ترکیب">
            <select className={inputClass} value={stacking} onChange={(e) => setStacking(e.target.value)}>
              <option value="exclusive">انحصاری</option>
              <option value="stackable">ترکیب‌پذیر</option>
            </select>
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="از تاریخ (شمسی)">
            <JalaliDatePicker className={inputClass} value={activeFrom} onChange={setActiveFrom} />
          </Field>
          <Field label="تا تاریخ (شمسی)">
            <JalaliDatePicker className={inputClass} value={activeTo} onChange={setActiveTo} />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="از ساعت">
            <input className={inputClass} dir="ltr" type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
          </Field>
          <Field label="تا ساعت">
            <input className={inputClass} dir="ltr" type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" disabled={busy} className="min-h-11 w-full">
          ذخیره کمپین
        </Button>
      </form>
    </SectionCard>
  );
}
