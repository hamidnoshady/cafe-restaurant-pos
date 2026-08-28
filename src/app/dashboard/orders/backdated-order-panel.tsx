"use client";

/**
 * «ثبت سفارش گذشته» — entering a sale that already happened.
 *
 * Deliberately not the POS screen with a date box bolted on. The POS is built
 * for speed on a live bill; this is a slow, deliberate, back-office form where
 * every field is something the person is copying off a paper receipt — the day,
 * the time, what was on it, how it was paid, and why it is being typed in now.
 * Making it look like the till would invite exactly the mistake the reason field
 * exists to record.
 *
 * The day and the time are read as the *branch's* wall clock (the server
 * resolves them; see instantInTimeZone), so a laptop on the wrong timezone
 * cannot shift the sale.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, errorMessage } from "../ui";
import { CARD, DANGER_BUTTON, OPS_INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON, STEPPER_BUTTON } from "./ops-styles";

interface MenuItem {
  id: string;
  name: string;
  price: string | number;
  is_active?: boolean;
}

interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  settlement: string;
  requiresReference: boolean;
}

interface BackdatedEntry {
  id: string;
  orderId: string;
  orderNumber: number;
  occurredAt: string;
  entryDate: string;
  reason: string;
  total: number;
  recordedAt: string;
  recordedByName: string | null;
}

interface CartLine {
  menuItemId: string;
  quantity: number;
}

/** Persian text for the failures this form can actually provoke. */
const ERRORS: Record<string, string> = {
  occurred_at_in_future: "تاریخ فروش نمی‌تواند در آینده باشد.",
  occurred_at_too_old: "تاریخ فروش خیلی قدیمی است؛ حداکثر یک سال گذشته پذیرفته می‌شود.",
  invalid_occurred_at: "تاریخ یا ساعت فروش معتبر نیست.",
  invalid_reason: "دلیل ثبت با تأخیر را بنویسید (حداقل ۳ نویسه).",
  fiscal_period_locked: "این دوره مالی بسته شده است؛ فروش را نمی‌توان در آن ثبت کرد.",
  fiscal_period_soft_closed:
    "این دوره مالی نیمه‌بسته است؛ فقط مالک یا حسابدار می‌تواند در آن سند بزند.",
  no_items: "دست‌کم یک قلم به فاکتور اضافه کنید.",
  no_payment: "روش پرداخت را انتخاب کنید.",
  customer_required: "برای فروش نسیه باید مشتری انتخاب شود.",
  monthly_order_limit_exceeded: "سقف ماهانهٔ سفارش‌های پلن شما پر شده است.",
};

export function BackdatedOrderPanel() {
  const money = useMoney();
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
  const [entries, setEntries] = useState<BackdatedEntry[]>([]);

  const [occurredOn, setOccurredOn] = useState("");
  const [occurredTime, setOccurredTime] = useState("20:00");
  const [type, setType] = useState<"dine_in" | "takeaway" | "delivery">("takeaway");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [addItemId, setAddItemId] = useState("");
  const [methodId, setMethodId] = useState("");
  const [reference, setReference] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const loadEntries = useCallback(async () => {
    const { ok, data } = await api<{ entries: BackdatedEntry[] }>("/api/orders/backdated");
    if (ok) setEntries(data.entries ?? []);
  }, []);

  useEffect(() => {
    void api<{ items: MenuItem[] }>("/api/menu").then(({ ok, data }) => {
      if (ok) setMenuItems((data.items ?? []).filter((item) => item.is_active !== false));
    });
    void api<{ paymentMethods: PaymentMethod[] }>("/api/payment-methods").then(({ ok, data }) => {
      if (!ok) return;
      setPaymentMethods(data.paymentMethods ?? []);
      setMethodId((current) => current || (data.paymentMethods ?? [])[0]?.id || "");
    });
    void loadEntries();
  }, [loadEntries]);

  const selectedMethod = paymentMethods.find((method) => method.id === methodId) ?? null;

  const estimate = useMemo(
    () =>
      lines.reduce((sum, line) => {
        const item = menuItems.find((candidate) => candidate.id === line.menuItemId);
        return sum + Number(item?.price ?? 0) * line.quantity;
      }, 0),
    [lines, menuItems],
  );

  function setQuantity(menuItemId: string, delta: number) {
    setLines((rows) =>
      rows
        .map((row) => (row.menuItemId === menuItemId ? { ...row, quantity: row.quantity + delta } : row))
        .filter((row) => row.quantity > 0),
    );
  }

  function reset() {
    setLines([]);
    setReason("");
    setNote("");
    setReference("");
  }

  async function submit() {
    setError("");
    setInfo("");
    if (!occurredOn) return setError(ERRORS.invalid_occurred_at);
    if (lines.length === 0) return setError(ERRORS.no_items);
    if (!methodId) return setError(ERRORS.no_payment);

    setSaving(true);
    const { ok, data } = await api<{ entryDate?: string; orderNumber?: number; total?: number; error?: string }>(
      "/api/orders/backdated",
      {
        method: "POST",
        body: JSON.stringify({
          occurredOn,
          occurredTime,
          type,
          reason,
          note: note || null,
          lines,
          payments: [{ methodId, reference: reference || null }],
        }),
      },
    );
    setSaving(false);

    if (!ok) {
      setError(ERRORS[data.error ?? ""] ?? errorMessage(data.error));
      return;
    }
    setInfo(
      `فاکتور شمارهٔ ${toPersianDigits(data.orderNumber ?? 0)} به مبلغ ${money.format(
        Number(data.total ?? 0),
      )} روی روز کاری ${toPersianDigits(formatJalali(data.entryDate ?? ""))} ثبت شد.`,
    );
    reset();
    void loadEntries();
  }

  return (
    <div className="flex flex-col gap-4">
      <section className={`${CARD} p-4`}>
        <h2 className="text-sm font-bold text-stone-950">ثبت سفارش گذشته</h2>
        <p className="mt-1 text-xs leading-6 text-stone-600">
          فروشی که قبلاً انجام شده — شبی که سیستم قطع بود، یا فروش پیش از نصب. سفارش با همان تاریخ در
          گزارش‌ها، دفتر کل و انبار ثبت می‌شود، نه با تاریخ امروز.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-stone-600">تاریخ فروش</span>
            <div className={OPS_INPUT}>
              <JalaliDatePicker
                value={occurredOn}
                onChange={setOccurredOn}
                placeholder="انتخاب روز"
                className="min-h-10 w-full min-w-0 bg-transparent text-sm text-stone-950 outline-none"
              />
            </div>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-stone-600">ساعت فروش (به وقت شعبه)</span>
            <input
              type="time"
              value={occurredTime}
              onChange={(event) => setOccurredTime(event.target.value)}
              className={OPS_INPUT}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-stone-600">نوع سفارش</span>
            <select
              value={type}
              onChange={(event) => setType(event.target.value as typeof type)}
              className={OPS_INPUT}
            >
              <option value="takeaway">بیرون‌بر</option>
              <option value="dine_in">سالن</option>
              <option value="delivery">ارسال</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-stone-600">روش پرداخت</span>
            <select
              value={methodId}
              onChange={(event) => setMethodId(event.target.value)}
              className={OPS_INPUT}
            >
              {paymentMethods.map((method) => (
                <option key={method.id} value={method.id}>
                  {method.name}
                </option>
              ))}
            </select>
          </label>

          {selectedMethod?.requiresReference && (
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-stone-600">شمارهٔ پیگیری</span>
              <input
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                className={OPS_INPUT}
                placeholder="شمارهٔ رسید دستگاه"
              />
            </label>
          )}
        </div>

        <div className="mt-4 flex flex-col gap-2">
          <span className="text-xs font-semibold text-stone-600">اقلام فاکتور</span>
          {lines.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200/80 p-3 text-xs text-stone-500">
              هنوز قلمی اضافه نشده است.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {lines.map((line) => {
                const item = menuItems.find((candidate) => candidate.id === line.menuItemId);
                return (
                  <li
                    key={line.menuItemId}
                    className="flex items-center gap-2 rounded-xl border border-stone-200/80 bg-stone-50 p-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-stone-950">{item?.name ?? "—"}</span>
                    <span className="text-xs text-stone-500">{money.format(Number(item?.price ?? 0))}</span>
                    <button
                      type="button"
                      aria-label="کاهش تعداد"
                      className={STEPPER_BUTTON}
                      onClick={() => setQuantity(line.menuItemId, -1)}
                    >
                      −
                    </button>
                    <span className="w-8 text-center text-sm font-bold text-stone-950">
                      {toPersianDigits(line.quantity)}
                    </span>
                    <button
                      type="button"
                      aria-label="افزایش تعداد"
                      className={STEPPER_BUTTON}
                      onClick={() => setQuantity(line.menuItemId, 1)}
                    >
                      +
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="min-w-0 flex-1">
              <SearchableSelect
                value={addItemId}
                onChange={setAddItemId}
                ariaLabel="افزودن قلم به سفارش گذشته"
                className={OPS_INPUT}
                options={[
                  { value: "", label: "افزودن قلم…" },
                  ...menuItems.map((item) => ({ value: item.id, label: item.name })),
                ]}
              />
            </div>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => {
                if (!addItemId) return;
                setLines((rows) =>
                  rows.some((row) => row.menuItemId === addItemId)
                    ? rows.map((row) =>
                        row.menuItemId === addItemId ? { ...row, quantity: row.quantity + 1 } : row,
                      )
                    : [...rows, { menuItemId: addItemId, quantity: 1 }],
                );
                setAddItemId("");
              }}
            >
              افزودن
            </button>
          </div>
        </div>

        <label className="mt-4 flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-stone-600">
            دلیل ثبت با تأخیر <span className="text-destructive">*</span>
          </span>
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            className={OPS_INPUT}
            placeholder="مثلاً: شب قطعی برق، فاکتورها دستی نوشته شد"
          />
        </label>

        <label className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-stone-600">یادداشت سفارش (اختیاری)</span>
          <input value={note} onChange={(event) => setNote(event.target.value)} className={OPS_INPUT} />
        </label>

        {lines.length > 0 && (
          <p className="mt-3 text-xs text-stone-600">
            جمع اقلام پیش از مالیات و تخفیف: <b>{money.format(estimate)}</b>
          </p>
        )}

        {error && (
          <p className="mt-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </p>
        )}
        {info && (
          <p className="mt-3 rounded-xl border border-stone-200/80 bg-stone-50 p-3 text-xs text-stone-950">
            {info}
          </p>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <button type="button" className={PRIMARY_BUTTON} disabled={saving} onClick={() => void submit()}>
            {saving ? "در حال ثبت…" : "ثبت فروش گذشته"}
          </button>
          <button type="button" className={DANGER_BUTTON} disabled={saving} onClick={reset}>
            پاک کردن فرم
          </button>
        </div>
      </section>

      <section className={`${CARD} p-4`}>
        <h3 className="text-sm font-bold text-stone-950">آخرین سفارش‌های گذشته‌ای که ثبت شده</h3>
        {entries.length === 0 ? (
          <p className="mt-2 text-xs text-stone-500">هنوز چیزی با تأخیر ثبت نشده است.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-xl border border-stone-200/80 bg-stone-50 p-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-bold text-stone-950">
                    فاکتور {toPersianDigits(entry.orderNumber)} — {money.format(entry.total)}
                  </span>
                  <span className="text-stone-600">
                    روز کاری {toPersianDigits(formatJalali(entry.entryDate))}
                  </span>
                </div>
                <p className="mt-1 text-stone-600">{entry.reason}</p>
                <p className="mt-1 text-stone-500">
                  ثبت‌شده در {toPersianDigits(formatJalali(entry.recordedAt.slice(0, 10)))}
                  {entry.recordedByName ? ` توسط ${entry.recordedByName}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
