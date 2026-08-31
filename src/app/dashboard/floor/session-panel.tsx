"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { BanknoteIcon, CreditCardIcon, UsersIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";

interface SessionDetail {
  session: {
    id: string;
    status: string;
    party_size: number | null;
    guest_name: string | null;
    opened_at: string;
    bill_requested_at: string | null;
    note: string | null;
  };
  tables: { id: string; name: string; capacity: number }[];
  orders: {
    id: string;
    order_number: number;
    status: string;
    subtotal: number | string;
    total: number | string;
    opened_at: string;
  }[];
  guests: {
    guestNumber: number;
    customerId: string;
    customerName: string;
    customerPhone: string | null;
  }[];
  bill: { total: number; lines: { orderItemId: string; orderId: string; name: string; amount: number }[] };
}

interface Customer {
  id: string;
  name: string;
  phone: string | null;
}

type PaymentMethod = "cash" | "card" | "card_to_card" | "snappfood";

export function SessionPanel({
  sessionId,
  onChange,
  setError,
}: {
  sessionId: string;
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const money = useMoney();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoaded, setDetailLoaded] = useState(false);
  const [freeTables, setFreeTables] = useState<{ id: string; name: string }[]>([]);
  const [mergeTableId, setMergeTableId] = useState("");
  const [showSplit, setShowSplit] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<SessionDetail>(`/api/table-sessions/${sessionId}`);
      if (res.ok) setDetail(res.data);
      else setError("بارگذاری نشست میز ممکن نشد.");
      const tRes = await api<{ tables: { id: string; name: string; status: string }[] }>("/api/tables");
      if (tRes.ok) setFreeTables(tRes.data.tables.filter((t) => t.status === "free"));
    } catch {
      setError("بارگذاری نشست میز ممکن نشد.");
    } finally {
      setDetailLoaded(true);
    }
  }, [sessionId, setError]);

  useEffect(() => {
    setDetail(null);
    setDetailLoaded(false);
    void load();
  }, [load]);

  async function action(body: object) {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/table-sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return false;
    }
    await load();
    onChange();
    return true;
  }

  if (!detail) {
    return detailLoaded ? null : (
      <LoadingSkeleton rows={3} compact className="mt-4" label="در حال بارگذاری نشست" />
    );
  }

  const { session, tables, orders, bill } = detail;

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-bold">نشست میز</h3>
        <span className="text-xs text-muted-foreground">
          {session.party_size ? `${toPersianDigits(session.party_size)} نفر` : "—"}
          {session.guest_name ? ` · ${session.guest_name}` : ""}
        </span>
      </div>
      {tables.length > 1 ? (
        <p className="mb-2 text-xs text-muted-foreground">میزها: {tables.map((t) => t.name).join("، ")}</p>
      ) : null}

      <div className="mb-3 rounded-lg bg-muted/50 p-3 text-sm">
        {orders.length === 0 ? (
          <p className="text-xs text-muted-foreground">هنوز سفارشی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-1">
            {orders.map((o) => (
              <li key={o.id} className="flex justify-between gap-2">
                <span className="text-muted-foreground">سفارش #{toPersianDigits(o.order_number)}{o.status === "voided" ? " (باطل)" : ""}</span>
                <span>{money.format(Number(o.total))}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex justify-between border-t border-border pt-2 font-bold">
          <span>جمع صورتحساب</span>
          <span>{money.format(bill.total)}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {!session.bill_requested_at ? (
          <SecondaryButton onClick={() => void action({ action: "request_bill" })} disabled={busy}>درخواست صورتحساب</SecondaryButton>
        ) : (
          <span className="rounded-lg bg-purple-50 px-3 py-2 text-xs text-purple-700 dark:bg-purple-950 dark:text-purple-300">صورتحساب درخواست شد</span>
        )}
        <SecondaryButton onClick={() => setShowSplit(true)} disabled={busy || bill.total <= 0}>تقسیم صورتحساب</SecondaryButton>
        <PrimaryButton
          type="button"
          onClick={async () => {
            if (await action({ action: "close" })) toast.success("میز بسته شد");
          }}
          disabled={busy}
        >
          بستن میز
        </PrimaryButton>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <SearchableSelect
          className={`${inputClass} py-1 text-xs`}
          value={mergeTableId}
          onChange={setMergeTableId}
          options={[{ value: "", label: "ادغام با میز آزاد…" }, ...freeTables.map((t) => ({ value: t.id, label: t.name }))]}
        />
        <SecondaryButton onClick={() => mergeTableId && void action({ action: "merge", tableId: mergeTableId })} disabled={busy || !mergeTableId}>ادغام</SecondaryButton>
      </div>

      {showSplit ? (
        <SplitDialog
          sessionId={sessionId}
          bill={bill}
          initialGuests={detail.guests}
          onClose={() => setShowSplit(false)}
          onChanged={onChange}
          setError={setError}
        />
      ) : null}
    </div>
  );
}

function SplitDialog({
  sessionId,
  bill,
  initialGuests,
  onClose,
  onChanged,
  setError,
}: {
  sessionId: string;
  bill: SessionDetail["bill"];
  initialGuests: SessionDetail["guests"];
  onClose: () => void;
  onChanged: () => void;
  setError: (s: string) => void;
}) {
  const money = useMoney();
  const [mode, setMode] = useState<"even" | "itemized">("even");
  const [guests, setGuests] = useState(String(Math.max(2, initialGuests.length || 2)));
  const [customerIds, setCustomerIds] = useState<(string | null)[]>(() => {
    const count = Math.max(2, initialGuests.length || 2);
    return Array.from({ length: count }, (_, index) => initialGuests[index]?.customerId ?? null);
  });
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customersLoading, setCustomersLoading] = useState(true);
  const [assignments, setAssignments] = useState<Record<string, number>>({});
  const [shares, setShares] = useState<number[] | null>(null);
  const [shareCustomerNames, setShareCustomerNames] = useState<string[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [busy, setBusy] = useState(false);

  const guestCount = Math.max(1, Math.min(50, Number(guests) || 1));
  const customerOptions = [
    { value: "", label: "بدون مشتری" },
    ...customers.map((customer) => ({
      value: customer.id,
      label: customer.phone ? `${customer.name} — ${toPersianDigits(customer.phone)}` : customer.name,
      searchString: `${customer.name} ${customer.phone ?? ""}`,
    })),
  ];

  // ⚡ Bolt: Prevent O(G * L) array recreation. When mode is "itemized", every line item
  // rendered its own identical array of guest options. This computes it once per guest count change.
  const guestOptions = useMemo(() => [
    { value: "", label: "مشترک" },
    ...Array.from({ length: guestCount }, (_, index) => ({
      value: String(index),
      label: `مهمان ${toPersianDigits(index + 1)}`,
    }))
  ], [guestCount]);

  useEffect(() => {
    let cancelled = false;
    setCustomersLoading(true);
    const timer = setTimeout(() => {
      void api<{ customers: Customer[] }>(`/api/customers?q=${encodeURIComponent(customerQuery)}`)
        .then(({ ok, data }) => {
          if (!cancelled && ok) setCustomers(data.customers);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setCustomersLoading(false);
        });
    }, customerQuery.trim() ? 200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [customerQuery]);

  function setGuestCount(value: string) {
    setGuests(value);
    const count = Math.max(1, Math.min(50, Number(value) || 1));
    setCustomerIds((previous) => Array.from({ length: count }, (_, index) => previous[index] ?? null));
    setShares(null);
  }

  async function saveGuests() {
    const ids = Array.from({ length: guestCount }, (_, index) => customerIds[index] ?? null);
    const result = await api<{ error?: string }>(`/api/table-sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "set_guests", customerIds: ids }),
    });
    if (!result.ok) {
      setError(errorMessage(result.data.error));
      return false;
    }
    return true;
  }

  async function compute() {
    setBusy(true);
    setError("");
    setShares(null);
    if (!(await saveGuests())) {
      setBusy(false);
      return;
    }
    const res = await api<{ error?: string; shares?: number[] }>(`/api/table-sessions/${sessionId}/split`, {
      method: "POST",
      body: JSON.stringify({ mode, guests: guestCount, assignments: mode === "itemized" ? assignments : undefined }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    setShares(res.data.shares ?? null);
    const names = customerIds.map((id, index) => {
      const customer = customers.find((item) => item.id === id);
      return customer?.name ?? initialGuests.find((guest) => guest.customerId === id)?.customerName ?? `مهمان ${toPersianDigits(index + 1)}`;
    });
    setShareCustomerNames(names);
  }

  async function payAll() {
    setBusy(true);
    setError("");
    if (!(await saveGuests())) {
      setBusy(false);
      return;
    }
    const payerCustomerId = customerIds.find((id): id is string => Boolean(id)) ?? null;
    const result = await api<{ error?: string }>(`/api/table-sessions/${sessionId}/pay`, {
      method: "POST",
      body: JSON.stringify({ method: paymentMethod, customerId: payerCustomerId }),
    });
    setBusy(false);
    if (!result.ok) return setError(errorMessage(result.data.error));
    onChanged();
    onClose();
    toast.success("کل صورتحساب با یک پرداخت ثبت شد");
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>تقسیم صورتحساب و مشتری‌ها</DialogTitle></DialogHeader>

        <section className="rounded-xl border border-stone-200/80 bg-stone-50 p-3" aria-label="مشتری‌های میز">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold">مشتری‌های این میز</h3>
            <UsersIcon className="size-4 text-amber-700" aria-hidden="true" />
          </div>
          <label className="mb-3 flex items-center gap-2 text-sm">
            <span className="shrink-0">تعداد نفر</span>
            <PersianNumberInput className={`${inputClass} w-24`} inputMode="numeric" dir="ltr" value={guests} onChange={(event) => setGuestCount(event.target.value)} />
          </label>
          <div className="space-y-2">
            {Array.from({ length: guestCount }, (_, index) => (
              <div key={index} className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-xs text-muted-foreground">مهمان {toPersianDigits(index + 1)}</span>
                <SearchableSelect
                  className={`${inputClass} min-h-11 flex-1`}
                  value={customerIds[index] ?? ""}
                  onChange={(value) => setCustomerIds((previous) => previous.map((current, itemIndex) => itemIndex === index ? value || null : current))}
                  onQueryChange={setCustomerQuery}
                  loading={customersLoading}
                  options={customerOptions}
                  ariaLabel={`مشتری مهمان ${index + 1}`}
                  searchPlaceholder="جستجوی نام یا شماره…"
                  placeholder="بدون مشتری"
                />
              </div>
            ))}
          </div>
        </section>

        <div className="flex gap-1 rounded-xl bg-stone-100 p-1 text-sm">
          <button type="button" aria-pressed={mode === "even"} onClick={() => { setMode("even"); setShares(null); }} className={`min-h-11 flex-1 rounded-lg font-medium transition-colors ${mode === "even" ? "bg-amber-100 text-amber-950" : "text-stone-600 hover:bg-stone-50"}`}>تقسیم مساوی</button>
          <button type="button" aria-pressed={mode === "itemized"} onClick={() => { setMode("itemized"); setShares(null); }} className={`min-h-11 flex-1 rounded-lg font-medium transition-colors ${mode === "itemized" ? "bg-amber-100 text-amber-950" : "text-stone-600 hover:bg-stone-50"}`}>به تفکیک اقلام</button>
        </div>

        {mode === "itemized" ? (
          <div className="max-h-56 space-y-1 overflow-y-auto overscroll-contain rounded-lg border border-border p-2 text-sm">
            {bill.lines.map((line) => (
              <div key={line.orderItemId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate">{line.name} <span className="text-xs text-muted-foreground">{money.format(line.amount)}</span></span>
                <SearchableSelect
                  className={`${inputClass} w-28 py-1 text-xs`}
                  value={assignments[line.orderItemId]?.toString() ?? ""}
                  onChange={(value) => setAssignments((previous) => {
                    const next = { ...previous };
                    if (value === "") delete next[line.orderItemId]; else next[line.orderItemId] = Number(value);
                    return next;
                  })}
                  options={guestOptions}
                />
              </div>
            ))}
          </div>
        ) : null}

        <PrimaryButton type="button" onClick={() => void compute()} disabled={busy}>محاسبه سهم‌ها</PrimaryButton>

        {shares ? (
          <div className="rounded-lg bg-muted/50 p-3 text-sm">
            <p className="mb-2 font-semibold">سهم هر مشتری:</p>
            <ul className="space-y-1">
              {shares.map((share, index) => (
                <li key={index} className="flex justify-between gap-2"><span>{shareCustomerNames[index] ?? `مهمان ${toPersianDigits(index + 1)}`}</span><span className="font-medium">{money.format(share)}</span></li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t border-border pt-2 font-bold"><span>جمع</span><span>{money.format(shares.reduce((a, b) => a + b, 0))}</span></div>
          </div>
        ) : null}

        <section className="border-t border-border pt-3" aria-label="پرداخت یکجای صورتحساب">
          <p className="mb-2 text-xs font-semibold text-muted-foreground">پرداخت کل با یک پرداخت</p>
          <div className="mb-2 grid grid-cols-3 gap-2">
            <button type="button" onClick={() => setPaymentMethod("cash")} className={`flex min-h-12 items-center justify-center gap-1 rounded-lg border text-xs font-bold ${paymentMethod === "cash" ? "border-amber-500 bg-amber-100 text-amber-700" : "border-border"}`}><BanknoteIcon className="size-4" aria-hidden="true" />نقدی</button>
            <button type="button" onClick={() => setPaymentMethod("card")} className={`flex min-h-12 items-center justify-center gap-1 rounded-lg border text-xs font-bold ${paymentMethod === "card" ? "border-amber-500 bg-amber-100 text-amber-700" : "border-border"}`}><CreditCardIcon className="size-4" aria-hidden="true" />کارت</button>
            <button type="button" onClick={() => setPaymentMethod("card_to_card")} className={`flex min-h-12 items-center justify-center rounded-lg border text-xs font-bold ${paymentMethod === "card_to_card" ? "border-amber-500 bg-amber-100 text-amber-700" : "border-border"}`}>کارت‌به‌کارت</button>
          </div>
          <PrimaryButton type="button" onClick={() => void payAll()} disabled={busy || bill.total <= 0}>پرداخت کل {money.format(bill.total)}</PrimaryButton>
        </section>
      </DialogContent>
    </Dialog>
  );
}
