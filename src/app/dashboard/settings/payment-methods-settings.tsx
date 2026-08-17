"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from "lucide-react";
import { CUSTOM_PAYMENT_SETTLEMENTS, type PaymentMethodView, type PaymentSettlement } from "@/lib/payment-methods";
import { ErrorBox, Field, InfoBox, PrimaryButton, api, errorMessage, inputClass } from "../ui";
import { paymentWayIcon } from "../payment-ways";

/** How each settlement reads to an owner choosing one, and where the money lands. */
const SETTLEMENT_LABELS: Record<PaymentSettlement, string> = {
  cash: "نقدی — به صندوق (۱۰۱۰)",
  card: "کارت‌خوان — به بانک در راه (۱۰۲۰)",
  card_to_card: "کارت‌به‌کارت — به بانک در راه (۱۰۲۰)",
  online: "درگاه آنلاین — به بانک در راه (۱۰۲۰)",
  credit: "نسیه — به حساب‌های دریافتنی (۱۳۰۰)",
  snappfood: "اسنپ‌فود — به مطالبات از پلتفرم",
};

/**
 * The payment ways a business offers, and the order the till shows them in.
 *
 * Two things are deliberately not editable here. A built-in way cannot be
 * deleted (the app names `cash`, `credit` and `snappfood` by code), and no
 * way's *settlement* can change once it has taken money — that would
 * re-describe payments already posted to a different account. Both have the
 * same answer, which this panel offers instead: deactivate it. A retired way
 * stops being offered at the till and stays on every payment that used it.
 */
export function PaymentMethodsSettings() {
  const [methods, setMethods] = useState<PaymentMethodView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [name, setName] = useState("");
  const [settlement, setSettlement] = useState<PaymentSettlement>("cash");
  const [requiresReference, setRequiresReference] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ paymentMethods: PaymentMethodView[]; error?: string }>(
      "/api/settings/payment-methods",
    );
    if (ok) setMethods(data.paymentMethods ?? []);
    else setError(errorMessage(data.error));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(url: string, init: RequestInit, success: string) {
    setBusy(true);
    setError("");
    setInfo("");
    const { ok, data } = await api<{ error?: string }>(url, init);
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    setInfo(success);
    await load();
    return true;
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError(errorMessage("invalid_name"));
    const added = await send(
      "/api/settings/payment-methods",
      { method: "POST", body: JSON.stringify({ name, settlement, requiresReference }) },
      "روش پرداخت اضافه شد.",
    );
    if (added) {
      setName("");
      setRequiresReference(false);
    }
  }

  function patch(method: PaymentMethodView, body: Record<string, unknown>, success: string) {
    return send(`/api/settings/payment-methods/${method.id}`, { method: "PATCH", body: JSON.stringify(body) }, success);
  }

  /** Moves one way past its neighbour and sends the whole order back. */
  function move(index: number, direction: -1 | 1) {
    const next = [...methods];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setMethods(next);
    void send(
      "/api/settings/payment-methods",
      { method: "PUT", body: JSON.stringify({ order: next.map((method) => method.id) }) },
      "ترتیب نمایش ذخیره شد.",
    );
  }

  if (loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold">روش‌های دریافت وجه</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          همین فهرست و همین ترتیب در صندوق فروش و صفحهٔ سفارش‌ها نمایش داده می‌شود. صندوق‌دار می‌تواند مبلغ یک فاکتور را
          بین چند روش تقسیم کند؛ مثلاً بخشی نقدی و بخشی با کارت‌خوان.
        </p>

        <ul className="space-y-2">
          {methods.map((method, index) => {
            const Icon = paymentWayIcon(method);
            return (
              <li
                key={method.id}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-border p-3"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <input
                  className={inputClass + " min-w-0 flex-1 sm:max-w-56"}
                  value={method.name}
                  aria-label={`نام ${method.name}`}
                  disabled={busy}
                  onChange={(event) =>
                    setMethods((current) =>
                      current.map((row) => (row.id === method.id ? { ...row, name: event.target.value } : row)),
                    )
                  }
                  onBlur={(event) => {
                    const value = event.target.value.trim();
                    if (!value || value === method.name.trim()) return;
                    void patch(method, { name: value }, "نام روش پرداخت ذخیره شد.");
                  }}
                />
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {SETTLEMENT_LABELS[method.settlement]}
                </span>

                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={method.isActive}
                    disabled={busy}
                    onChange={(event) =>
                      void patch(
                        method,
                        { isActive: event.target.checked },
                        event.target.checked ? "روش پرداخت فعال شد." : "روش پرداخت غیرفعال شد.",
                      )
                    }
                  />
                  فعال
                </label>
                <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={method.requiresReference}
                    disabled={busy}
                    onChange={(event) =>
                      void patch(method, { requiresReference: event.target.checked }, "تنظیم شمارهٔ پیگیری ذخیره شد.")
                    }
                  />
                  شمارهٔ پیگیری
                </label>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={busy || index === 0}
                    className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground disabled:opacity-40"
                    aria-label={`بردن ${method.name} به بالا`}
                  >
                    <ChevronUpIcon className="size-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={busy || index === methods.length - 1}
                    className="flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground disabled:opacity-40"
                    aria-label={`بردن ${method.name} به پایین`}
                  >
                    <ChevronDownIcon className="size-4" aria-hidden="true" />
                  </button>
                  {method.isBuiltin ? null : (
                    <button
                      type="button"
                      onClick={() =>
                        void send(
                          `/api/settings/payment-methods/${method.id}`,
                          { method: "DELETE" },
                          "روش پرداخت حذف شد.",
                        )
                      }
                      disabled={busy}
                      className="flex size-9 items-center justify-center rounded-lg border border-destructive/30 text-destructive disabled:opacity-40"
                      aria-label={`حذف ${method.name}`}
                    >
                      <TrashIcon className="size-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <form onSubmit={add} className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 text-lg font-semibold">افزودن روش پرداخت</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          نام را به دلخواه بنویسید (مثلاً «پوز بانک ملت» یا «کیف پول»). «نحوهٔ تسویه» تعیین می‌کند مبلغ به کدام حساب
          دفتر کل بنشیند و پس از اولین دریافت با این روش قابل تغییر نیست.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="نام روش">
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="مثلاً پوز بانک ملت"
              maxLength={40}
            />
          </Field>
          <Field label="نحوهٔ تسویه">
            <select
              className={inputClass}
              value={settlement}
              onChange={(event) => setSettlement(event.target.value as PaymentSettlement)}
            >
              {CUSTOM_PAYMENT_SETTLEMENTS.map((value) => (
                <option key={value} value={value}>
                  {SETTLEMENT_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <label className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={requiresReference}
            onChange={(event) => setRequiresReference(event.target.checked)}
          />
          صندوق‌دار هنگام دریافت، شمارهٔ پیگیری وارد کند
        </label>
        <PrimaryButton disabled={busy || !name.trim()}>افزودن روش پرداخت</PrimaryButton>
      </form>
    </div>
  );
}
