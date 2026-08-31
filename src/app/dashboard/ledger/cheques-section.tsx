"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * The cheque register (چک‌ها).
 *
 * Two registers behind one tab — cheques we hold and cheques we wrote — because
 * they are the same object seen from two sides, and a treasurer wants both in
 * one place: what is due, and what has to be covered.
 *
 * Every action here is one step of the cheque's life, and each step posts its
 * own journal entry server-side. Which steps are offered comes from
 * `availableActions` (src/lib/cheques.ts) rather than being decided again in the
 * markup — the register can't offer a transition the server would refuse.
 */
import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  availableActions,
  type ChequeAction,
  type ChequeDirection,
  type ChequeStatus,
} from "@/lib/cheques";
import { api, ErrorBox, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { JalaliDatePicker } from "../jalali-date-picker";

interface Cheque {
  id: string;
  direction: ChequeDirection;
  status: ChequeStatus;
  serialNumber: string;
  sayadId: string | null;
  bankName: string;
  amount: number;
  issueDate: string;
  dueDate: string;
  counterpartyName: string;
  memo: string | null;
}

const STATUS_LABELS: Record<ChequeStatus, string> = {
  on_hand: "نزد صندوق",
  in_collection: "در جریان وصول",
  endorsed: "واگذارشده (ظهرنویسی)",
  issued: "صادرشده",
  cleared: "وصول‌شده",
  bounced: "برگشتی",
  cancelled: "ابطال‌شده",
};

const ACTION_LABELS: Record<ChequeAction, string> = {
  deposit: "واگذاری به بانک",
  endorse: "ظهرنویسی",
  clear: "وصول",
  present: "پاس شد",
  bounce: "برگشت خورد",
  cancel: "ابطال",
};

/** A live cheque reads as neutral, a cleared one as settled, a bounced one as a problem. */
const STATUS_CLASS: Record<ChequeStatus, string> = {
  on_hand: "bg-amber-100 text-amber-700",
  in_collection: "bg-amber-100 text-amber-700",
  endorsed: "bg-primary/10 text-primary",
  issued: "bg-amber-100 text-amber-700",
  cleared: "bg-emerald-50 text-emerald-700",
  bounced: "bg-destructive/10 text-destructive",
  cancelled: "bg-stone-100 text-stone-500",
};

interface Counterparty {
  id: string;
  name: string;
}

export function ChequesSection({
  busy,
  run,
}: {
  busy: boolean;
  run: (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;
}) {
  const money = useMoney();
  const [direction, setDirection] = useState<ChequeDirection>("receivable");
  const [cheques, setCheques] = useState<Cheque[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [endorseTarget, setEndorseTarget] = useState<Cheque | null>(null);
  const [customers, setCustomers] = useState<Counterparty[]>([]);
  const [suppliers, setSuppliers] = useState<Counterparty[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    setCheques(null);
    api<{ cheques: Cheque[] }>(`/api/ledger/cheques?direction=${direction}`).then(({ ok, data }) => {
      if (ok) setCheques(data.cheques);
      else setCheques([]);
    });
  }, [direction, refreshKey]);

  // The counterparties a cheque can settle: whoever has a balance to settle.
  useEffect(() => {
    api<{ customers: { customerId: string; customerName: string }[] }>("/api/ledger/ar/customers").then(
      ({ ok, data }) => {
        if (ok) setCustomers(data.customers.map((c) => ({ id: c.customerId, name: c.customerName })));
      },
    );
    api<{ suppliers: { supplierId: string; supplierName: string }[] }>("/api/ledger/ap/suppliers").then(
      ({ ok, data }) => {
        if (ok) setSuppliers(data.suppliers.map((s) => ({ id: s.supplierId, name: s.supplierName })));
      },
    );
  }, [refreshKey]);

  async function act(cheque: Cheque, action: ChequeAction, body: Record<string, unknown> = {}) {
    const done = await run(() =>
      api(`/api/ledger/cheques/${cheque.id}/${action}`, { method: "POST", body: JSON.stringify(body) }),
    );
    if (done) {
      setEndorseTarget(null);
      setRefreshKey((k) => k + 1);
    }
  }

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <div className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-amber-700">اسناد دریافتنی و پرداختنی</p>
            <h2 className="mt-1">چک‌ها</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              چک‌های دریافتی و صادرشده، سررسیدشان، و هر مرحله از وصول یا ظهرنویسی — هر مرحله سند حسابداری خودش را ثبت می‌کند.
            </p>
          </div>
          <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-0">
            {(["receivable", "payable"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={direction === value}
                onClick={() => {
                  setDirection(value);
                  setAdding(false);
                }}
                className={`min-h-12 rounded-xl border px-3 text-sm ${
                  direction === value
                    ? "border-amber-200 bg-amber-100 font-semibold text-amber-700"
                    : "border-transparent text-muted-foreground hover:border-stone-200/80 hover:bg-stone-50"
                }`}
              >
                {value === "receivable" ? "چک‌های دریافتی" : "چک‌های صادرشده"}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5">
          {cheques === null ? (
            <LoadingSkeleton rows={3} />
          ) : cheques.length === 0 ? (
            <p className="rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-muted-foreground">
              چکی ثبت نشده است.
            </p>
          ) : (
            <ul className="space-y-2">
              {cheques.map((cheque) => (
                <li key={cheque.id} className="rounded-xl border border-stone-200/80 bg-stone-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-stone-950">{cheque.counterpartyName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {cheque.bankName} — شماره {toPersianDigits(cheque.serialNumber)}
                        {cheque.sayadId ? ` — صیاد ${toPersianDigits(cheque.sayadId)}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        سررسید {toPersianDigits(formatJalali(cheque.dueDate))}
                      </p>
                    </div>
                    <div className="text-end">
                      <p className="tabular-nums font-bold text-stone-950">{money.format(cheque.amount)}</p>
                      <span className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_CLASS[cheque.status]}`}>
                        {STATUS_LABELS[cheque.status]}
                      </span>
                    </div>
                  </div>

                  {availableActions(cheque.direction, cheque.status).length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
                      {availableActions(cheque.direction, cheque.status).map((action) => (
                        <SecondaryButton
                          key={action}
                          disabled={busy}
                          onClick={() => (action === "endorse" ? setEndorseTarget(cheque) : void act(cheque, action))}
                        >
                          {ACTION_LABELS[action]}
                        </SecondaryButton>
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-5 border-t border-stone-100 pt-4">
          {adding ? (
            <ChequeForm
              direction={direction}
              counterparties={direction === "receivable" ? customers : suppliers}
              busy={busy}
              onCancel={() => setAdding(false)}
              onSubmit={async (body) => {
                const done = await run(() =>
                  api("/api/ledger/cheques", { method: "POST", body: JSON.stringify({ direction, ...body }) }),
                );
                if (done) {
                  setAdding(false);
                  setRefreshKey((k) => k + 1);
                }
              }}
            />
          ) : (
            <PrimaryButton type="button" onClick={() => setAdding(true)}>
              {direction === "receivable" ? "ثبت چک دریافتی" : "ثبت چک صادرشده"}
            </PrimaryButton>
          )}
        </div>
      </div>

      {endorseTarget ? (
        <EndorseDialog
          cheque={endorseTarget}
          suppliers={suppliers}
          busy={busy}
          onCancel={() => setEndorseTarget(null)}
          onConfirm={(supplierId, occurredOn) =>
            act(endorseTarget, "endorse", { endorsedToSupplierId: supplierId, occurredOn })
          }
          onError={setError}
        />
      ) : null}
    </section>
  );
}

function ChequeForm({
  direction,
  counterparties,
  busy,
  onCancel,
  onSubmit,
}: {
  direction: ChequeDirection;
  counterparties: Counterparty[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const money = useMoney();
  const [serialNumber, setSerialNumber] = useState("");
  const [sayadId, setSayadId] = useState("");
  const [bankName, setBankName] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [counterpartyName, setCounterpartyName] = useState("");
  const [memo, setMemo] = useState("");

  const selected = counterparties.find((c) => c.id === counterpartyId);

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          serialNumber,
          sayadId: sayadId || undefined,
          bankName,
          amount: money.parse(amount),
          dueDate,
          // The name printed on the cheque, which need not be the account it
          // settles — a customer may hand over a cheque written by someone else.
          counterpartyName: counterpartyName.trim() || selected?.name || "",
          [direction === "receivable" ? "customerId" : "supplierId"]: counterpartyId || undefined,
          memo: memo || undefined,
        });
      }}
    >
      <label className="grid gap-1 text-sm">
        <span>شماره چک</span>
        <input className={inputClass} value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} required />
      </label>
      <label className="grid gap-1 text-sm">
        <span>بانک</span>
        <input className={inputClass} value={bankName} onChange={(e) => setBankName(e.target.value)} required />
      </label>
      <label className="grid gap-1 text-sm">
        <span>شناسه صیاد (اختیاری)</span>
        <PersianNumberInput
          className={inputClass}
          value={sayadId}
          onChange={(e) => setSayadId(e.target.value)}
          inputMode="numeric"
          grouping={false}
          allowNegative={false}
        />
      </label>
      <label className="grid gap-1 text-sm">
        <span>مبلغ ({money.unitLabel})</span>
        <PersianNumberInput className={inputClass} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" required />
      </label>
      <label className="grid gap-1 text-sm">
        <span>سررسید</span>
        <JalaliDatePicker className={inputClass} value={dueDate} onChange={setDueDate} />
      </label>
      <div className="grid gap-1 text-sm">
        <span>{direction === "receivable" ? "مشتری" : "تأمین‌کننده"}</span>
        <SearchableSelect
          value={counterpartyId}
          onChange={setCounterpartyId}
          options={counterparties.map((c) => ({ value: c.id, label: c.name }))}
          ariaLabel={direction === "receivable" ? "مشتری" : "تأمین‌کننده"}
        />
      </div>
      <label className="grid gap-1 text-sm">
        <span>نام صاحب چک (در صورت تفاوت)</span>
        <input className={inputClass} value={counterpartyName} onChange={(e) => setCounterpartyName(e.target.value)} placeholder={selected?.name ?? ""} />
      </label>
      <label className="grid gap-1 text-sm sm:col-span-2">
        <span>توضیح</span>
        <input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} />
      </label>
      <div className="grid gap-2 sm:grid-cols-2 sm:col-span-2">
        <PrimaryButton type="submit" disabled={busy}>ثبت چک</PrimaryButton>
        <SecondaryButton onClick={onCancel}>انصراف</SecondaryButton>
      </div>
    </form>
  );
}

/**
 * Endorsement needs the supplier the cheque is being handed to — that is the
 * whole entry (Debit حساب‌های پرداختنی / Credit چک‌های نزد صندوق), so it can't
 * be a one-tap action like the rest.
 */
function EndorseDialog({
  cheque,
  suppliers,
  busy,
  onCancel,
  onConfirm,
  onError,
}: {
  cheque: Cheque;
  suppliers: Counterparty[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (supplierId: string, occurredOn: string | undefined) => void;
  onError: (message: string) => void;
}) {
  const money = useMoney();
  const [supplierId, setSupplierId] = useState("");
  const [occurredOn, setOccurredOn] = useState("");

  return (
    <div className="rounded-2xl border border-stone-200/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-4 sm:p-5">
      <h3 className="font-semibold text-stone-950">
        ظهرنویسی چک {toPersianDigits(cheque.serialNumber)} — {money.format(cheque.amount)}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        چک به تأمین‌کننده واگذار می‌شود و بدهی او به همین مبلغ کم می‌شود. اگر چک برگشت بخورد، بدهی دوباره برمی‌گردد.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1 text-sm">
          <span>تأمین‌کننده</span>
          <SearchableSelect
            value={supplierId}
            onChange={setSupplierId}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
            ariaLabel="تأمین‌کننده"
          />
        </div>
        <label className="grid gap-1 text-sm">
          <span>تاریخ واگذاری</span>
          <JalaliDatePicker className={inputClass} value={occurredOn} onChange={setOccurredOn} />
        </label>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <PrimaryButton
          type="button"
          disabled={busy}
          onClick={() => {
            if (!supplierId) {
              onError("انتخاب تأمین‌کننده الزامی است.");
              return;
            }
            onConfirm(supplierId, occurredOn || undefined);
          }}
        >
          ثبت ظهرنویسی
        </PrimaryButton>
        <SecondaryButton onClick={onCancel}>انصراف</SecondaryButton>
      </div>
    </div>
  );
}
