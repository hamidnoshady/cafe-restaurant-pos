"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatToman, parseToRial } from "@/lib/money";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox, Field, inputClass } from "../ui";

interface PromotionRow {
  id: string;
  name: string;
  kind: string;
  value: number;
  minQuantity: number | null;
  priority: number;
  stacking: string;
  isActive: boolean;
  activeFrom: string | null;
  activeTo: string | null;
  timeFrom: string | null;
  timeTo: string | null;
}

const KIND_LABELS: Record<string, string> = {
  percent: "درصدی",
  amount: "مبلغ ثابت",
  bundle_price: "ست هدیه (قیمت کل)",
  buy_x_get_y: "تعداد مشخص با قیمت ثابت",
};

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-5">
      <h2 className="font-semibold text-stone-950">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

export default function PromotionsPage() {
  const [promotions, setPromotions] = useState<PromotionRow[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    api<{ promotions: PromotionRow[] }>("/api/promotions").then(({ ok, data }) => ok && setPromotions(data.promotions));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <header className="mb-5 border-b border-stone-200/80 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-stone-950">کمپین تخفیف و کارت هدیه</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          یک موتور تخفیف برای همه کسب‌وکارها؛ تخفیف هرگز از مبلغ خط بیشتر نمی‌شود.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {done ? <p className="mb-3 text-xs text-emerald-700">{done}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <PromotionForm
          onSaved={(m) => {
            setDone(m);
            load();
          }}
          onError={setError}
        />
        <GiftCardPanel
          onChanged={(m) => {
            setDone(m);
          }}
          onError={setError}
        />
      </div>

      <div className="mt-4">
        <Panel title="کمپین‌های فعال">
          {promotions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">
              هنوز کمپینی تعریف نشده است.
            </p>
          ) : (
            <ul className="divide-y divide-stone-200/80 text-sm">
              {promotions.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="font-medium text-stone-950">{p.name}</span>
                    <span className="mr-2 text-xs text-muted-foreground">
                      {KIND_LABELS[p.kind]} · اولویت {formatPersianNumber(p.priority)} ·{" "}
                      {p.stacking === "exclusive" ? "انحصاری" : "ترکیب‌پذیر"}
                    </span>
                    {(p.activeFrom || p.activeTo) && (
                      <span className="mr-2 text-xs text-muted-foreground">
                        {p.activeFrom ? toPersianDigits(formatJalali(p.activeFrom)) : "…"} تا{" "}
                        {p.activeTo ? toPersianDigits(formatJalali(p.activeTo)) : "…"}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {p.kind === "percent" ? `${formatPersianNumber(p.value)}٪` : formatToman(p.value)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

function PromotionForm({ onSaved, onError }: { onSaved: (m: string) => void; onError: (m: string) => void }) {
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
        value: kind === "percent" ? Number(value) : parseToRial(value, "toman"),
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
    <Panel title="کمپین جدید">
      <form onSubmit={submit} className="grid gap-3">
        <Field label="نام کمپین">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="نوع">
            <select className={inputClass} value={kind} onChange={(e) => setKind(e.target.value)}>
              {Object.entries(KIND_LABELS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={kind === "percent" ? "درصد" : "مبلغ (تومان)"}>
            <input className={inputClass} dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
        </div>
        {kind === "buy_x_get_y" ? (
          <Field label="حداقل تعداد برای قیمت ثابت">
            <input className={inputClass} dir="ltr" value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} />
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Field label="اولویت (بیشتر = زودتر)">
            <input className={inputClass} dir="ltr" value={priority} onChange={(e) => setPriority(e.target.value)} />
          </Field>
          <Field label="قانون ترکیب">
            <select className={inputClass} value={stacking} onChange={(e) => setStacking(e.target.value)}>
              <option value="exclusive">انحصاری</option>
              <option value="stackable">ترکیب‌پذیر</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="از تاریخ (میلادی)">
            <input className={inputClass} dir="ltr" type="date" value={activeFrom} onChange={(e) => setActiveFrom(e.target.value)} />
          </Field>
          <Field label="تا تاریخ (میلادی)">
            <input className={inputClass} dir="ltr" type="date" value={activeTo} onChange={(e) => setActiveTo(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
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
    </Panel>
  );
}

function GiftCardPanel({ onChanged, onError }: { onChanged: (m: string) => void; onError: (m: string) => void }) {
  const [code, setCode] = useState("");
  const [issueValue, setIssueValue] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemValue, setRedeemValue] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function issue() {
    if (!code.trim() || !issueValue.trim()) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/promotions/gift-cards", {
      method: "POST",
      body: JSON.stringify({ code, initialValue: parseToRial(issueValue, "toman") }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "صدور کارت هدیه ناموفق بود.");
    else {
      setCode("");
      setIssueValue("");
      onChanged("کارت هدیه صادر شد (بدهی ۲۴۲۰).");
    }
  }

  async function check() {
    if (!redeemCode.trim()) return;
    const { ok, data } = await api<{ balance: number }>(`/api/promotions/gift-cards?code=${encodeURIComponent(redeemCode)}`);
    if (ok) setBalance(data.balance);
  }

  async function redeem() {
    if (!redeemCode.trim() || !redeemValue.trim()) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string; balance?: number }>("/api/promotions/gift-cards/redeem", {
      method: "POST",
      body: JSON.stringify({ code: redeemCode, amount: parseToRial(redeemValue, "toman") }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "مصرف کارت هدیه ناموفق بود.");
    else {
      setBalance(data.balance ?? null);
      setRedeemValue("");
      onChanged("کارت هدیه مصرف شد.");
    }
  }

  return (
    <Panel title="کارت هدیه">
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <Field label="کد کارت جدید">
          <input className={inputClass} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} />
        </Field>
        <Field label="ارزش (تومان)">
          <input className={inputClass} dir="ltr" value={issueValue} onChange={(e) => setIssueValue(e.target.value)} />
        </Field>
        <Button type="button" disabled={busy} onClick={() => void issue()} className="min-h-11">
          صدور
        </Button>
      </div>

      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <Field label="کد کارت">
          <input className={inputClass} dir="ltr" value={redeemCode} onChange={(e) => setRedeemCode(e.target.value)} />
        </Field>
        <Field label="مبلغ مصرف (تومان)">
          <input className={inputClass} dir="ltr" value={redeemValue} onChange={(e) => setRedeemValue(e.target.value)} />
        </Field>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void check()} className="min-h-11">
          مانده
        </Button>
      </div>
      <Button type="button" disabled={busy || !redeemCode.trim() || !redeemValue.trim()} onClick={() => void redeem()} className="min-h-11 w-full">
        مصرف کارت
      </Button>
      {balance != null ? <p className="text-xs text-muted-foreground">ماندهٔ کارت: {formatToman(balance)}</p> : null}
      <p className="text-xs leading-5 text-muted-foreground">
        کارت هدیه یک بدهی واقعی (حساب ۲۴۲۰) است؛ صدور آن را بستانکار و مصرف آن را بدهکار می‌کند و هرگز درآمد را دوباره ثبت نمی‌کند.
      </p>
    </Panel>
  );
}
