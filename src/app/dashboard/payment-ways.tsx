"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * The payment ways a cashier picks from, and the panel that splits a bill
 * across them. Shared by the POS and the order dialog so the two checkouts
 * can't drift — the ways, their order, and the arithmetic are the same thing
 * in both places (see src/lib/payment-draft.ts for the arithmetic).
 */
import { useCallback, useEffect, useState } from "react";
import { BanknoteIcon, CreditCardIcon, PlusIcon, ReceiptTextIcon, ScrollTextIcon, SmartphoneIcon, WalletIcon, XIcon } from "lucide-react";
import { useMoney } from "@/components/money/money-context";
import {
  draftRemaining,
  newDraftRow,
  type PaymentDraft,
} from "@/lib/payment-draft";
import type { PaymentMethodView, PaymentSettlement } from "@/lib/payment-methods";
import { api } from "./ui";

/** A settlement's icon — a way a business added is recognisable by how it settles. */
const SETTLEMENT_ICONS: Record<PaymentSettlement, typeof BanknoteIcon> = {
  cash: BanknoteIcon,
  card: CreditCardIcon,
  card_to_card: WalletIcon,
  online: SmartphoneIcon,
  credit: ReceiptTextIcon,
  cheque: ScrollTextIcon,
  snappfood: SmartphoneIcon,
};

export function paymentWayIcon(method: PaymentMethodView) {
  return SETTLEMENT_ICONS[method.settlement] ?? WalletIcon;
}

/**
 * The business's payment ways, fetched once per screen.
 *
 * `methods` is empty until the fetch lands, which is why every caller gates
 * its checkout button on it: paying with no way chosen is exactly the request
 * the server refuses, so the screen shouldn't offer it either.
 */
export function usePaymentMethods(): {
  methods: PaymentMethodView[];
  loaded: boolean;
  reload: () => void;
} {
  const [methods, setMethods] = useState<PaymentMethodView[]>([]);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    void api<{ paymentMethods: PaymentMethodView[] }>("/api/payment-methods").then(({ ok, data }) => {
      if (ok) setMethods(data.paymentMethods ?? []);
      setLoaded(true);
    });
  }, []);

  useEffect(reload, [reload]);
  return { methods, loaded, reload };
}

const CHIP_ON = "border-amber-200 bg-amber-100 text-amber-700";
const CHIP_OFF = "border-stone-200/80 text-stone-600 hover:bg-stone-50";

const AMOUNT_INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-stone-200/80 bg-white px-2 text-sm tabular-nums outline-none focus-visible:border-amber-500 focus-visible:ring-2 focus-visible:ring-amber-500/30";

export interface PaymentWaysProps {
  methods: PaymentMethodView[];
  draft: PaymentDraft;
  onChange: (draft: PaymentDraft) => void;
  /** The bill the split has to cover, in Rial. */
  due: number;
  disabled?: boolean;
  /** Distinguishes the ids of two panels rendered at once (the POS has a desktop and a sheet copy). */
  idPrefix?: string;
}

export function PaymentWays({ methods, draft, onChange, due, disabled, idPrefix = "pay" }: PaymentWaysProps) {
  const money = useMoney();
  const remaining = draftRemaining(draft, due, money.unit);

  /**
   * Tapping a way while splitting *adds* it, pre-filled with whatever is still
   * owed — the two-tap "۲۰۰٬۰۰۰ نقدی، rest on card" case, which is most of
   * them. Tapping it while not splitting just selects it.
   */
  function chooseWay(methodId: string) {
    if (!draft.split) {
      onChange({ ...draft, methodId, rows: [newDraftRow(methodId)] });
      return;
    }
    const prefill = remaining > 0 ? String(money.toInput(remaining)) : "";
    onChange({ ...draft, rows: [...draft.rows, newDraftRow(methodId, prefill)] });
  }

  function toggleSplit() {
    if (draft.split) {
      // Collapsing keeps the way of the first slice, so the cashier doesn't
      // land back on an unrelated button.
      const methodId = draft.rows[0]?.methodId ?? draft.methodId;
      onChange({ split: false, methodId, rows: [newDraftRow(methodId)] });
      return;
    }
    const prefill = due > 0 ? String(money.toInput(due)) : "";
    onChange({ ...draft, split: true, rows: [newDraftRow(draft.methodId, prefill)] });
  }

  function patchRow(key: string, patch: { amount?: string; reference?: string }) {
    onChange({ ...draft, rows: draft.rows.map((row) => (row.key === key ? { ...row, ...patch } : row)) });
  }

  function removeRow(key: string) {
    onChange({ ...draft, rows: draft.rows.filter((row) => row.key !== key) });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-bold text-stone-600">روش دریافت وجه</p>
        <button
          type="button"
          onClick={toggleSplit}
          disabled={disabled || methods.length === 0}
          className={
            "rounded-lg border px-2 py-1 text-xs font-bold transition disabled:opacity-55 " +
            (draft.split ? CHIP_ON : CHIP_OFF)
          }
        >
          {draft.split ? "پرداخت یکجا" : "تقسیم بین چند روش"}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {methods.map((method) => {
          const Icon = paymentWayIcon(method);
          const selected = !draft.split && draft.methodId === method.id;
          return (
            <button
              key={method.id}
              type="button"
              onClick={() => chooseWay(method.id)}
              disabled={disabled}
              className={
                "flex min-h-14 items-center justify-center gap-2 rounded-xl border px-2 text-center text-sm font-bold transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 disabled:opacity-55 motion-reduce:transition-none " +
                (selected ? CHIP_ON : CHIP_OFF)
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{method.name}</span>
            </button>
          );
        })}
      </div>
      {methods.length === 0 ? (
        <p className="mt-2 text-xs text-stone-400">روشی برای دریافت وجه تعریف نشده است.</p>
      ) : null}

      {draft.split ? (
        <div className="mt-3 space-y-2 rounded-xl border border-stone-200/80 bg-stone-50 p-2">
          {draft.rows.length === 0 ? (
            <p className="px-1 py-2 text-xs text-stone-400">
              یکی از روش‌های بالا را بزنید تا سهم آن از مبلغ اضافه شود.
            </p>
          ) : null}
          {draft.rows.map((row, index) => {
            const method = methods.find((candidate) => candidate.id === row.methodId);
            return (
              <div key={row.key} className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-bold text-stone-950">
                    {method?.name ?? "—"}
                  </span>
                  <PersianNumberInput
                    id={`${idPrefix}-tender-${index}`}
                    className={AMOUNT_INPUT + " max-w-32"}
                    dir="ltr"
                    inputMode="numeric"
                    value={row.amount}
                    disabled={disabled}
                    onChange={(event) => patchRow(row.key, { amount: event.target.value })}
                    placeholder={money.unit === "rial" ? "ریال" : "تومان"}
                    aria-label={`مبلغ ${method?.name ?? ""}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(row.key)}
                    disabled={disabled}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-200/80 text-stone-400 hover:bg-white disabled:opacity-55"
                    aria-label={`حذف ${method?.name ?? ""}`}
                  >
                    <XIcon className="size-4" aria-hidden="true" />
                  </button>
                </div>
                {method?.requiresReference ? (
                  <input
                    className={AMOUNT_INPUT}
                    dir="ltr"
                    value={row.reference}
                    disabled={disabled}
                    onChange={(event) => patchRow(row.key, { reference: event.target.value })}
                    placeholder="شمارهٔ پیگیری"
                    aria-label={`شمارهٔ پیگیری ${method.name}`}
                  />
                ) : null}
              </div>
            );
          })}

          <div className="flex items-center justify-between border-t border-stone-200/80 pt-2 text-xs font-bold">
            <span className="text-stone-600">
              {remaining > 0 ? "باقی‌مانده" : remaining < 0 ? "مازاد (بازگشت به مشتری)" : "تسویه شد"}
            </span>
            <span className={remaining === 0 ? "text-emerald-700" : "text-destructive"}>
              {money.format(Math.abs(remaining))}
            </span>
          </div>
          {draft.rows.length > 0 && remaining > 0 ? (
            <p className="flex items-center gap-1 text-[11px] text-stone-400">
              <PlusIcon className="size-3" aria-hidden="true" />
              روش دیگری را از بالا بزنید تا {money.format(remaining)} باقی‌مانده با آن دریافت شود.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
