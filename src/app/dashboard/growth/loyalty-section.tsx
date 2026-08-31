"use client";

/**
 * The Growth app's loyalty section (Phase 36b) — the old /dashboard/loyalty
 * page, moved into the app it always belonged to. Unchanged in substance:
 * programs define the earn rate and the point's Rial value, points redeem into
 * store credit, and store credit is a real liability (۲۴۱۰) whose balance is
 * reconstructed from the ledger, never stored in a column. A cashier lands
 * here directly — this is the one growth surface the sell-side of the business
 * works with.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { EmptyState, LoadingSkeleton, SectionCard, SectionCardSkeleton } from "../page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "../ui";

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

export function LoyaltySection() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [balance, setBalance] = useState<{ points: number; storeCredit: number } | null>(null);
  const [balanceLoaded, setBalanceLoaded] = useState(true);
  const [due, setDue] = useState<RepurchaseRow[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [programResult, customerResult, repurchaseResult] = await Promise.allSettled([
      api<{ programs: Program[] }>("/api/loyalty/programs"),
      api<{ customers?: Customer[] }>("/api/customers"),
      api<{ customers: RepurchaseRow[] }>("/api/loyalty/repurchase"),
    ]);
    if (programResult.status === "fulfilled" && programResult.value.ok) {
      setPrograms(programResult.value.data.programs);
    }
    if (customerResult.status === "fulfilled" && customerResult.value.ok) {
      setCustomers(customerResult.value.data.customers ?? []);
    }
    if (repurchaseResult.status === "fulfilled" && repurchaseResult.value.ok) {
      setDue(repurchaseResult.value.data.customers);
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setBalance(null);
    if (!customerId) {
      setBalanceLoaded(true);
      return;
    }
    let cancelled = false;
    setBalanceLoaded(false);
    void api<{ points: number; storeCredit: number }>(`/api/loyalty/customers/${customerId}`)
      .then(({ ok, data }) => {
        if (!cancelled && ok) setBalance(data);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setBalanceLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const customer = customers.find((c) => c.id === customerId);

  if (!loaded) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCardSkeleton rows={4} />
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}

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
          balanceLoaded={balanceLoaded}
          onChanged={(m) => {
            setDone(m);
            load();
            setCustomerId("");
          }}
          onError={setError}
        />
      </div>

      <SectionCard title="مشتریان آمادهٔ خرید مجدد" description="پیش‌بینی از تاریخچهٔ خرید خود مشتری؛ موعدِ گذشته یعنی وقت تماس یا پیام">
        {due.length === 0 ? (
          <EmptyState>هنوز مشتری‌ای در موعد خرید مجدد نیست.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {due.map((r) => (
              <li key={`${r.customerId}-${r.productName}`} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <span className="font-medium text-foreground">{r.customerName}</span>
                  <span className="mr-2 text-xs text-muted-foreground">{r.productName}</span>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  موعد {toPersianDigits(formatJalali(r.predictedDate))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
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
    <SectionCard title="برنامهٔ وفاداری" bodyClassName="space-y-3 p-4 sm:p-5">
      <ul className="divide-y divide-border/80 text-sm">
        {programs.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 py-2">
            <span className="font-medium text-foreground">
              {p.name}
              {p.isDefault ? <span className="mr-2 text-xs text-amber-700 dark:text-amber-300">(پیش‌فرض)</span> : null}
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
            <PersianNumberInput
              inputMode="numeric"
              className={inputClass}
              dir="ltr"
              value={earn}
              onChange={(e) => setEarn(e.target.value)}
            />
          </Field>
          <Field label={`ارزش هر امتیاز (${money.unitLabel})`}>
            <PersianNumberInput
              inputMode="numeric"
              className={inputClass}
              dir="ltr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <Field label="انقضای امتیاز (روز)">
            <PersianNumberInput
              inputMode="numeric"
              className={inputClass}
              dir="ltr"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              placeholder="خالی = بدون انقضا"
            />
          </Field>
        </div>
        <Button type="submit" disabled={busy} className="min-h-11 w-full">
          ذخیره برنامه
        </Button>
      </form>
    </SectionCard>
  );
}

function CustomerPanel({
  customers,
  customer,
  customerId,
  setCustomerId,
  balance,
  balanceLoaded,
  onChanged,
  onError,
}: {
  customers: Customer[];
  customer: Customer | undefined;
  customerId: string;
  setCustomerId: (v: string) => void;
  balance: { points: number; storeCredit: number } | null;
  balanceLoaded: boolean;
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
    <SectionCard title="مشتری و اعتبار" bodyClassName="space-y-3 p-4 sm:p-5">
      <Field label="مشتری">
        <SearchableSelect
          value={customerId}
          onChange={setCustomerId}
          options={customers.map((c) => ({ value: c.id, label: c.phone ? `${c.name} — ${c.phone}` : c.name }))}
          placeholder="انتخاب مشتری"
        />
      </Field>

      {customer && !balanceLoaded ? (
        <LoadingSkeleton rows={1} compact label="در حال بارگذاری مانده مشتری" />
      ) : customer && balance ? (
        <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/80 p-3 text-sm">
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
          <PersianNumberInput
            inputMode="numeric"
            className={inputClass}
            dir="ltr"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            placeholder="تعداد امتیاز"
          />
        </Field>
        <Button type="button" disabled={busy || !customerId || !points.trim()} onClick={() => void redeem()} className="min-h-11">
          تبدیل
        </Button>
      </div>

      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <Field label={`اعتبار فروشگاهی (${money.unitLabel})`}>
          <PersianNumberInput
            inputMode="numeric"
            className={inputClass}
            dir="ltr"
            value={credit}
            onChange={(e) => setCredit(e.target.value)}
          />
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
        اعتبار فروشگاهی یک بدهی واقعی (حساب ۲۴۱۰) است که در تراز آزمایشی دیده می‌شود؛ ماندهٔ آن از دفتر کل بازسازی
        می‌شود، نه از یک ستون.
      </p>
    </SectionCard>
  );
}
