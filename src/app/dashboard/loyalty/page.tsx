"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { api, ErrorBox, Field, inputClass } from "../ui";

interface Program {
  id: string;
  name: string;
  earnPointsPer100000: number;
  pointValueRial: number;
  pointsExpiryDays: number | null;
  isActive: boolean;
  isDefault: boolean;
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
}

interface RepurchaseRow {
  customerId: string;
  customerName: string;
  productName: string;
  predictedDate: string;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-5">
      <h2 className="font-semibold text-stone-950">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

export default function LoyaltyPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [balance, setBalance] = useState<{ points: number; storeCredit: number } | null>(null);
  const [due, setDue] = useState<RepurchaseRow[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    api<{ programs: Program[] }>("/api/loyalty/programs").then(({ ok, data }) => ok && setPrograms(data.programs));
    api<{ customers?: Customer[] }>("/api/customers").then(({ ok, data }) => ok && setCustomers(data.customers ?? []));
    api<{ customers: RepurchaseRow[] }>("/api/loyalty/repurchase").then(({ ok, data }) => ok && setDue(data.customers));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    setBalance(null);
    if (!customerId) return;
    api<{ points: number; storeCredit: number }>(`/api/loyalty/customers/${customerId}`).then(({ ok, data }) => {
      if (ok) setBalance(data);
    });
  }, [customerId]);

  const customer = customers.find((c) => c.id === customerId);

  return (
    <div className="mx-auto w-full max-w-[1100px]">
      <header className="mb-5 border-b border-stone-200/80 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-stone-950">وفاداری و اعتبار فروشگاهی</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          امتیاز مشتریان، اعتبار فروشگاهی به‌عنوان بدهی واقعی، و فهرست «آماده خرید مجدد».
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {done ? <p className="mb-3 text-xs text-emerald-700">{done}</p> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <ProgramsPanel
          programs={programs}
          onSaved={(m) => {
            setDone(m);
            load();
          }}
          onError={setError}
        />
        <CustomerPanel
          customers={customers}
          customer={customer}
          customerId={customerId}
          setCustomerId={setCustomerId}
          balance={balance}
          onChanged={(m) => {
            setDone(m);
            load();
            setCustomerId("");
          }}
          onError={setError}
        />
      </div>

      <div className="mt-4">
        <Panel title="مشتریان آماده خرید مجدد">
          {due.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">
              هنوز مشتری‌ای در موعد خرید مجدد نیست.
            </p>
          ) : (
            <ul className="divide-y divide-stone-200/80 text-sm">
              {due.map((r) => (
                <li key={`${r.customerId}-${r.productName}`} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <span className="font-medium text-stone-950">{r.customerName}</span>
                    <span className="mr-2 text-xs text-muted-foreground">{r.productName}</span>
                  </div>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    موعد {toPersianDigits(formatJalali(r.predictedDate))}
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

function ProgramsPanel({
  programs,
  onSaved,
  onError,
}: {
  programs: Program[];
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [name, setName] = useState("");
  const [earn, setEarn] = useState("1");
  const [value, setValue] = useState("100");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/loyalty/programs", {
      method: "POST",
      body: JSON.stringify({
        name,
        earnPointsPer100000: Number(earn) || 1,
        pointValueRial: money.fromInput(Math.max(0, Math.round(Number(value) || 0))) || 1000,
        pointsExpiryDays: expiry.trim() ? Number(expiry) : null,
        isDefault: programs.length === 0,
      }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "ثبت برنامه ناموفق بود.");
    else {
      setName("");
      onSaved("برنامه وفاداری ذخیره شد.");
    }
  }

  return (
    <Panel title="برنامه وفاداری">
      <ul className="divide-y divide-stone-200/80 text-sm">
        {programs.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 py-2">
            <span className="font-medium text-stone-950">
              {p.name}
              {p.isDefault ? <span className="mr-2 text-xs text-amber-700">(پیش‌فرض)</span> : null}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatPersianNumber(p.earnPointsPer100000)} امتیاز / ۱۰٬۰۰۰ تومان · هر امتیاز {money.format(p.pointValueRial)}
            </span>
          </li>
        ))}
        {programs.length === 0 ? <li className="py-2 text-xs text-muted-foreground">هنوز برنامه‌ای تعریف نشده است.</li> : null}
      </ul>
      <form onSubmit={submit} className="grid gap-3">
        <Field label="نام برنامه">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="امتیاز / ۱۰ هزار تومان">
            <input className={inputClass} dir="ltr" value={earn} onChange={(e) => setEarn(e.target.value)} />
          </Field>
          <Field label={`ارزش هر امتیاز (${money.unitLabel})`}>
            <input className={inputClass} dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="انقضای امتیاز (روز)">
            <input className={inputClass} dir="ltr" value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder="خالی = بدون انقضا" />
          </Field>
        </div>
        <Button type="submit" disabled={busy} className="min-h-11 w-full">
          ذخیره برنامه
        </Button>
      </form>
    </Panel>
  );
}

function CustomerPanel({
  customers,
  customer,
  customerId,
  setCustomerId,
  balance,
  onChanged,
  onError,
}: {
  customers: Customer[];
  customer: Customer | undefined;
  customerId: string;
  setCustomerId: (v: string) => void;
  balance: { points: number; storeCredit: number } | null;
  onChanged: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [points, setPoints] = useState("");
  const [credit, setCredit] = useState("");
  const [creditAction, setCreditAction] = useState<"issue" | "use">("issue");
  const [busy, setBusy] = useState(false);

  async function redeem() {
    if (!customerId || !points.trim()) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/loyalty/customers/${customerId}/redeem`, {
      method: "POST",
      body: JSON.stringify({ points: Number(points) }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "تبدیل امتیاز ناموفق بود.");
    else {
      setPoints("");
      onChanged("امتیاز به اعتبار فروشگاهی تبدیل شد.");
    }
  }

  async function storeCredit() {
    if (!customerId || !credit.trim()) return;
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/loyalty/customers/${customerId}/store-credit`, {
      method: "POST",
      body: JSON.stringify({ action: creditAction, amount: money.parse(credit) }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "عملیات اعتبار ناموفق بود.");
    else {
      setCredit("");
      onChanged(creditAction === "issue" ? "اعتبار فروشگاهی صادر شد." : "اعتبار فروشگاهی مصرف شد.");
    }
  }

  return (
    <Panel title="مشتری و اعتبار">
      <Field label="مشتری">
        <SearchableSelect
          value={customerId}
          onChange={setCustomerId}
          options={customers.map((c) => ({ value: c.id, label: c.phone ? `${c.name} — ${c.phone}` : c.name }))}
          placeholder="انتخاب مشتری"
        />
      </Field>

      {customer && balance ? (
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-stone-200 p-3 text-sm">
          <div>
            <span className="text-muted-foreground">امتیاز:</span> <b>{formatPersianNumber(balance.points)}</b>
          </div>
          <div>
            <span className="text-muted-foreground">اعتبار:</span> <b>{money.format(balance.storeCredit)}</b>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field label="تبدیل امتیاز به اعتبار">
          <input className={inputClass} dir="ltr" value={points} onChange={(e) => setPoints(e.target.value)} placeholder="تعداد امتیاز" />
        </Field>
        <Button type="button" disabled={busy || !customerId || !points.trim()} onClick={() => void redeem()} className="min-h-11">
          تبدیل
        </Button>
      </div>

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field label={`اعتبار فروشگاهی (${money.unitLabel})`}>
          <input className={inputClass} dir="ltr" value={credit} onChange={(e) => setCredit(e.target.value)} />
        </Field>
        <div className="flex flex-col gap-1">
          <select className={inputClass} value={creditAction} onChange={(e) => setCreditAction(e.target.value as "issue" | "use")}>
            <option value="issue">صدور</option>
            <option value="use">مصرف (نقدی)</option>
          </select>
          <Button type="button" disabled={busy || !customerId || !credit.trim()} onClick={() => void storeCredit()} className="min-h-11">
            انجام
          </Button>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        اعتبار فروشگاهی یک بدهی واقعی (حساب ۲۴۱۰) است که در تراز آزمایشی دیده می‌شود؛ ماندهٔ آن از دفتر کل بازسازی می‌شود، نه از یک ستون.
      </p>
    </Panel>
  );
}
