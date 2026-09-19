"use client";

/**
 * The Growth app's loyalty section (Phase 36b) — the old /dashboard/loyalty
 * page, moved into the app it always belonged to. Unchanged in substance:
 * programs define the earn rate and the point's Rial value, points redeem into
 * store credit, and store credit is a real liability (۲۴۱۰) whose balance is
 * reconstructed from the ledger, never stored in a column. A cashier lands
 * here directly — this is the one growth surface the sell-side of the business
 * works with, so the management-only actions (defining programs, redeeming,
 * issuing/spending credit) are hidden for them rather than failing with a 403
 * after the form is filled.
 *
 * The customer picker is server-backed: the directory can hold thousands of
 * customers and the list endpoint caps a page at 100, so the picker refetches
 * on each keystroke (like the checkout picker) instead of pretending one page
 * is the whole directory.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { formatJalali } from "@/lib/jalali";
import { EmptyState, LoadingSkeleton, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";

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
  productId: string;
  productName: string;
  predictedDate: string;
}

export function LoyaltySection({ role }: { role?: string }) {
  // The write APIs (programs, redeem, store credit) are owner/manager-only;
  // a cashier gets the read surfaces: balances and the repurchase list.
  const canManage = ["owner", "manager"].includes(role ?? "");

  const [programs, setPrograms] = useState<Program[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerId, setCustomerId] = useState("");
  // Kept beside the search results: a refetch for a new query may not contain
  // the already-selected customer, and the picker must keep showing their name.
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [balance, setBalance] = useState<{ points: number; storeCredit: number } | null>(null);
  const [balanceLoaded, setBalanceLoaded] = useState(true);
  // Bumped after a redeem/credit action so the effect refetches the balance
  // for the *same* customer — deselecting them just to force a refresh made
  // the operator re-find the person to see the result of their own action.
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [due, setDue] = useState<RepurchaseRow[]>([]);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [loaded, setLoaded] = useState(false);

  // One box speaks at a time: a fresh error retires a stale success note and
  // a fresh success retires a stale error, so the screen never shows both.
  const showError = useCallback((message: string) => {
    setError(message);
    if (message) setDone("");
  }, []);
  const showDone = useCallback((message: string) => {
    setDone(message);
    if (message) setError("");
  }, []);

  const load = useCallback(async () => {
    const [programResult, repurchaseResult] = await Promise.allSettled([
      api<{ programs: Program[] }>("/api/loyalty/programs"),
      api<{ customers: RepurchaseRow[] }>("/api/loyalty/repurchase"),
    ]);
    let failed = false;
    if (programResult.status === "fulfilled" && programResult.value.ok) {
      setPrograms(programResult.value.data.programs);
    } else failed = true;
    if (repurchaseResult.status === "fulfilled" && repurchaseResult.value.ok) {
      setDue(repurchaseResult.value.data.customers);
    } else failed = true;
    if (failed) {
      // Without this, a dropped connection rendered an empty-but-healthy page.
      setError((current) => current || "بارگذاری اطلاعات کامل نشد؛ اتصال اینترنت را بررسی کنید و صفحه را دوباره باز کنید.");
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Server-backed customer search, debounced. The list endpoint caps a page at
  // 100 rows, so fetching "everything" silently hid the rest of the directory;
  // asking the search endpoint per keystroke finds any customer.
  useEffect(() => {
    let cancelled = false;
    setCustomersLoading(true);
    const timer = setTimeout(
      () => {
        void api<{ customers?: Customer[] }>(
          `/api/parties?q=${encodeURIComponent(customerQuery)}&roles=Customer&limit=50`,
        )
          .then(({ ok, data }) => {
            if (!cancelled && ok) setCustomers(data.customers ?? []);
          })
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) setCustomersLoading(false);
          });
      },
      customerQuery.trim() ? 200 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [customerQuery]);

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
  }, [customerId, balanceVersion]);

  // The search results, with the selected customer kept present even when the
  // current query's results no longer include them.
  const pickerCustomers = useMemo(() => {
    if (selectedCustomer && !customers.some((c) => c.id === selectedCustomer.id)) {
      return [selectedCustomer, ...customers];
    }
    return customers;
  }, [customers, selectedCustomer]);

  const selectCustomer = useCallback(
    (id: string) => {
      setCustomerId(id);
      setSelectedCustomer(id ? (pickerCustomers.find((c) => c.id === id) ?? null) : null);
    },
    [pickerCustomers],
  );

  const customer = pickerCustomers.find((c) => c.id === customerId);
  const defaultProgram = programs.find((p) => p.isDefault && p.isActive) ?? programs.find((p) => p.isActive) ?? null;

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
          canManage={canManage}
          onSaved={(m) => {
            showDone(m);
            load();
          }}
          onError={showError}
        />
        <CustomerPanel
          customers={pickerCustomers}
          customersLoading={customersLoading}
          onCustomerQueryChange={setCustomerQuery}
          customer={customer}
          customerId={customerId}
          setCustomerId={selectCustomer}
          balance={balance}
          balanceLoaded={balanceLoaded}
          canManage={canManage}
          defaultProgram={defaultProgram}
          onChanged={(m) => {
            showDone(m);
            load();
            // Refresh the same customer's balance in place — the operator
            // needs to see the result, not re-find the person.
            setBalanceVersion((v) => v + 1);
          }}
          onError={showError}
        />
      </div>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">بازگشت مشتری</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">مشتریان آمادهٔ خرید مجدد</h2>
          </div>
        }
        description="پیش‌بینی از تاریخچهٔ خرید خود مشتری؛ موعدِ گذشته یعنی وقت تماس یا پیام"
      >
        {due.length === 0 ? (
          <EmptyState>هنوز مشتری‌ای در موعد خرید مجدد نیست.</EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {due.map((r) => (
              <li key={`${r.customerId}-${r.productId}`} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{r.customerName}</p>
                  <p className="truncate text-xs text-muted-foreground">{r.productName}</p>
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
  canManage,
  onSaved,
  onError,
}: {
  programs: Program[];
  canManage: boolean;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [name, setName] = useState("");
  const [earn, setEarn] = useState("1");
  const [value, setValue] = useState("100");
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);

  // The earn rate's basis is 100,000 Rial; say it in the unit the business
  // displays, so a Rial-mode business is not told a Toman number.
  const earnBasisLabel = money.unit === "rial" ? "۱۰۰ هزار ریال" : "۱۰ هزار تومان";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    // Validate before flipping `busy`, and send what the user typed instead of
    // silently rewriting it: `Number(earn) || 1` turned an intentional 0 (no
    // earning) into 1, and `… || 1000` turned a 0 point value into 1000 Rial.
    const earnRate = earn.trim() === "" ? 1 : Number(earn);
    if (!Number.isInteger(earnRate) || earnRate < 0) {
      onError("نرخ کسب امتیاز باید یک عدد صحیح صفر یا بیشتر باشد.");
      return;
    }
    let pointValueRial: number | undefined;
    if (value.trim() !== "") {
      pointValueRial = money.fromInput(Number(value));
      if (!Number.isInteger(pointValueRial) || pointValueRial <= 0) {
        onError("ارزش هر امتیاز باید یک عدد بزرگ‌تر از صفر باشد.");
        return;
      }
    }
    const expiryDays = expiry.trim() ? Number(expiry) : null;
    if (expiryDays !== null && (!Number.isInteger(expiryDays) || expiryDays <= 0)) {
      onError("روزهای انقضای امتیاز باید عدد صحیح مثبت باشد یا خالی بماند.");
      return;
    }

    // Saving over an existing program must not silently demote the default:
    // the upsert overwrites `is_default` with whatever we send.
    const existing = programs.find((p) => p.name === name.trim());
    const isDefault = existing ? existing.isDefault : programs.length === 0;

    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/loyalty/programs", {
      method: "POST",
      body: JSON.stringify({
        name,
        earnPointsPer100000: earnRate,
        pointValueRial,
        pointsExpiryDays: expiryDays,
        isDefault,
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
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">طرح‌های امتیازدهی</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">برنامهٔ وفاداری</h2>
        </div>
      }
      bodyClassName="space-y-3 p-4 sm:p-5"
    >
      <ul className="divide-y divide-border/80 text-sm">
        {programs.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 py-2">
            <span className="min-w-0 font-medium text-foreground">
              {p.name}
              {p.isDefault ? <span className="mr-2 text-xs text-amber-700 dark:text-amber-300">(پیش‌فرض)</span> : null}
            </span>
            <span className="text-xs text-muted-foreground">
              {formatPersianNumber(p.earnPointsPer100000)} امتیاز / {earnBasisLabel} · هر امتیاز {money.format(p.pointValueRial)}
            </span>
          </li>
        ))}
        {programs.length === 0 ? <li className="py-2 text-xs text-muted-foreground">هنوز برنامه‌ای تعریف نشده است.</li> : null}
      </ul>
      {canManage ? (
        <form onSubmit={submit} className="grid gap-3">
          <Field label="نام برنامه" hint="نامِ تکراری همان برنامه را ویرایش می‌کند.">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label={`امتیاز / ${earnBasisLabel}`}>
              <PersianNumberInput
                inputMode="numeric"
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={earn}
                onChange={(e) => setEarn(e.target.value)}
              />
            </Field>
            <Field label={`ارزش هر امتیاز (${money.unitLabel})`}>
              <PersianNumberInput
                inputMode="numeric"
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
            <Field label="انقضای امتیاز (روز)">
              <PersianNumberInput
                inputMode="numeric"
                allowNegative={false}
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
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          تعریف و ویرایش برنامه‌های وفاداری با مدیر یا مالک کسب‌وکار است.
        </p>
      )}
    </SectionCard>
  );
}

function CustomerPanel({
  customers,
  customersLoading,
  onCustomerQueryChange,
  customer,
  customerId,
  setCustomerId,
  balance,
  balanceLoaded,
  canManage,
  defaultProgram,
  onChanged,
  onError,
}: {
  customers: Customer[];
  customersLoading: boolean;
  onCustomerQueryChange: (q: string) => void;
  customer: Customer | undefined;
  customerId: string;
  setCustomerId: (v: string) => void;
  balance: { points: number; storeCredit: number } | null;
  balanceLoaded: boolean;
  canManage: boolean;
  defaultProgram: Program | null;
  onChanged: (m: string) => void;
  onError: (m: string) => void;
}) {
  const money = useMoney();
  const [points, setPoints] = useState("");
  const [credit, setCredit] = useState("");
  const [creditAction, setCreditAction] = useState<"issue" | "use-cash" | "use-bank">("issue");
  const [busy, setBusy] = useState(false);

  const customerOptions = useMemo(
    () => [
      ...customers.map((c) => ({
        value: c.id,
        label: c.phone ? `${c.name} — ${toPersianDigits(c.phone)}` : c.name,
        searchString: `${c.name} ${c.phone ?? ""}`,
      })),
    ],
    [customers],
  );

  const pointsCount = Number(points);
  const pointsValid = Number.isInteger(pointsCount) && pointsCount > 0;
  const redeemHint = defaultProgram
    ? pointsValid
      ? `هر امتیاز ${money.format(defaultProgram.pointValueRial)} — معادل ${money.format(pointsCount * defaultProgram.pointValueRial)}`
      : `هر امتیاز ${money.format(defaultProgram.pointValueRial)}`
    : null;

  async function redeem() {
    if (!customerId || !points.trim()) return;
    if (!pointsValid) {
      onError("تعداد امتیاز باید یک عدد صحیح مثبت باشد.");
      return;
    }
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/loyalty/customers/${customerId}/redeem`, {
      method: "POST",
      body: JSON.stringify({ points: pointsCount }),
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
    // Parse *before* flipping `busy`: `money.parse` throws on non-numeric
    // input, and a throw after setBusy(true) left every button disabled.
    let amount: number;
    try {
      amount = money.parse(credit);
    } catch {
      onError("مبلغ واردشده معتبر نیست.");
      return;
    }
    if (amount <= 0) {
      onError("مبلغ اعتبار باید بزرگ‌تر از صفر باشد.");
      return;
    }
    const action = creditAction === "issue" ? "issue" : "use";
    setBusy(true);
    onError("");
    const { ok, data } = await api<{ error?: string; message?: string }>(`/api/loyalty/customers/${customerId}/store-credit`, {
      method: "POST",
      body: JSON.stringify({
        action,
        amount,
        ...(action === "use" ? { paymentMethod: creditAction === "use-bank" ? "bank" : "cash" } : {}),
      }),
    });
    setBusy(false);
    if (!ok) onError(data.message ?? "عملیات اعتبار ناموفق بود.");
    else {
      setCredit("");
      onChanged(action === "issue" ? "اعتبار فروشگاهی صادر شد." : "اعتبار فروشگاهی مصرف شد.");
    }
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">امور مالی مشتریان</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">مشتری و اعتبار</h2>
        </div>
      }
      bodyClassName="space-y-3 p-4 sm:p-5"
    >
      <Field label="مشتری">
        <SearchableSelect
          value={customerId}
          onChange={setCustomerId}
          options={customerOptions}
          loading={customersLoading}
          onQueryChange={onCustomerQueryChange}
          placeholder="انتخاب مشتری"
          searchPlaceholder="جستجوی نام یا شماره…"
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

      {canManage ? (
        <>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">تبدیل امتیاز به اعتبار</span>
              <PersianNumberInput
                inputMode="numeric"
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={points}
                onChange={(e) => setPoints(e.target.value)}
                placeholder="تعداد امتیاز"
              />
            </label>
            <Button
              type="button"
              disabled={busy || !customerId || !points.trim()}
              onClick={() => void redeem()}
              className="min-h-11 w-full sm:w-auto"
            >
              تبدیل
            </Button>
          </div>
          {redeemHint ? <p className="text-xs text-muted-foreground">{redeemHint}</p> : null}

          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">{`اعتبار فروشگاهی (${money.unitLabel})`}</span>
              <PersianNumberInput
                inputMode="numeric"
                allowNegative={false}
                className={inputClass}
                dir="ltr"
                value={credit}
                onChange={(e) => setCredit(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-foreground">عملیات</span>
              <select
                className={`${inputClass} sm:w-40`}
                value={creditAction}
                onChange={(e) => setCreditAction(e.target.value as "issue" | "use-cash" | "use-bank")}
              >
                <option value="issue">صدور</option>
                <option value="use-cash">مصرف (نقدی)</option>
                <option value="use-bank">مصرف (بانکی)</option>
              </select>
            </label>
            <Button
              type="button"
              disabled={busy || !customerId || !credit.trim()}
              onClick={() => void storeCredit()}
              className="min-h-11 w-full sm:w-auto"
            >
              انجام
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            اعتبار فروشگاهی یک بدهی واقعی (حساب ۲۴۱۰) است که در تراز آزمایشی دیده می‌شود؛ ماندهٔ آن از دفتر کل بازسازی
            می‌شود، نه از یک ستون.
          </p>
        </>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          تبدیل امتیاز و صدور یا مصرف اعتبار فروشگاهی با مدیر یا مالک کسب‌وکار است؛ از این‌جا می‌توانید ماندهٔ امتیاز و
          اعتبار هر مشتری را ببینید.
        </p>
      )}
    </SectionCard>
  );
}
