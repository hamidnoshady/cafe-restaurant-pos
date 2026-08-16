"use client";

/**
 * Editing or removing an order that has already been paid for.
 *
 * The panel deliberately looks nothing like the open-order controls above it:
 * every change here is a restatement of a settled bill, so it is composed as a
 * whole (quantities, removals, additions, discount, tender) with a mandatory
 * reason, reviewed against the amount it will re-post, and submitted once —
 * rather than the running, per-tap edits an open order allows.
 */
import { useEffect, useMemo, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, ErrorBox, errorMessage, InfoBox, inputClass, PrimaryButton, SecondaryButton } from "../../ui";

const METHODS = [
  { value: "", label: "همان روش قبلی" },
  { value: "cash", label: "نقدی" },
  { value: "card", label: "کارت‌خوان" },
  { value: "card_to_card", label: "کارت‌به‌کارت" },
  { value: "online", label: "آنلاین" },
  { value: "credit", label: "نسیه" },
  { value: "snappfood", label: "اسنپ‌فود" },
];

const KIND_LABELS: Record<string, string> = { edit: "ویرایش", void: "حذف" };

export interface AmendableItem {
  id: string;
  name: string;
  quantity: number;
  status: string;
}

export interface MenuOption {
  id: string;
  name: string;
}

interface AmendmentHistoryRow {
  id: string;
  kind: "edit" | "void";
  reason: string;
  previousTotal: number;
  newTotal: number;
  entryDate: string;
  createdAt: string;
  createdByName: string | null;
}

interface Draft {
  orderItemId: string;
  name: string;
  quantity: number;
  removed: boolean;
}

export function ClosedOrderAmendment({
  orderId,
  items,
  menuItems,
  discountType: initialDiscountType,
  discountValue: initialDiscountValue,
  onDone,
}: {
  orderId: string;
  items: AmendableItem[];
  menuItems: MenuOption[];
  discountType: "percent" | "amount" | null;
  discountValue: number | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft[]>([]);
  const [additions, setAdditions] = useState<{ menuItemId: string; quantity: number }[]>([]);
  const [addItemId, setAddItemId] = useState("");
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">(initialDiscountType ?? "");
  const [discountValue, setDiscountValue] = useState(initialDiscountValue ? String(initialDiscountValue) : "");
  const [method, setMethod] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [history, setHistory] = useState<AmendmentHistoryRow[]>([]);

  const liveItems = useMemo(() => items.filter((item) => item.status !== "voided"), [items]);

  useEffect(() => {
    setDraft(
      liveItems.map((item) => ({
        orderItemId: item.id,
        name: item.name,
        quantity: item.quantity,
        removed: false,
      })),
    );
  }, [liveItems]);

  const loadHistory = useMemo(
    () => () => {
      api<{ amendments: AmendmentHistoryRow[] }>(`/api/orders/${orderId}/amend`).then(
        ({ ok, data }) => ok && setHistory(data.amendments),
      );
    },
    [orderId],
  );
  useEffect(loadHistory, [loadHistory]);

  const keptLines = draft.filter((line) => !line.removed);
  const nothingLeft = keptLines.length === 0 && additions.length === 0;

  function setQuantity(orderItemId: string, quantity: number) {
    setDraft((rows) =>
      rows.map((row) => (row.orderItemId === orderItemId ? { ...row, quantity: Math.max(1, quantity) } : row)),
    );
  }

  async function submit(kind: "edit" | "void") {
    setBusy(true);
    setError("");
    setInfo("");
    const body =
      kind === "void"
        ? { kind, reason }
        : {
            kind,
            reason,
            lines: [
              ...keptLines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
              ...additions,
            ],
            discount: discountType ? { type: discountType, value: Number(discountValue) || 0 } : { type: null },
            paymentMethod: method || undefined,
          };
    const { ok, data } = await api<{ error?: string; newTotal?: number }>(`/api/orders/${orderId}/amend`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(
      kind === "void"
        ? "سفارش حذف شد؛ همهٔ اثرهای حسابداری، انبار و صندوق آن برگشت خورد."
        : `سفارش اصلاح شد؛ مبلغ جدید ${formatToman(Number(data.newTotal ?? 0))} در همان تاریخ فروش ثبت شد.`,
    );
    setOpen(false);
    setReason("");
    setAdditions([]);
    loadHistory();
    onDone();
  }

  return (
    <section className="mt-3 rounded-xl border border-destructive/30 bg-destructive/[0.03] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">اصلاح سفارش بسته‌شده</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            ویرایش یا حذف این سفارش، سند فروش، مالیات، بهای تمام‌شده، موجودی انبار و صندوق را در
            <b> همان تاریخ فروش </b>
            برگشت می‌زند و مقدار جدید را جایگزین می‌کند. اگر آن دوره مالی بسته شده باشد، عملیات انجام نمی‌شود.
          </p>
        </div>
        <SecondaryButton onClick={() => setOpen((value) => !value)} disabled={busy}>
          {open ? "بستن" : "اصلاح یا حذف"}
        </SecondaryButton>
      </div>

      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      {open ? (
        <div className="mt-3 space-y-4 border-t border-destructive/20 pt-3">
          <ul className="divide-y divide-border/80">
            {draft.map((line) => (
              <li key={line.orderItemId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <span className={line.removed ? "text-muted-foreground line-through" : "font-medium"}>
                  {line.name}
                </span>
                <div className="ms-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setQuantity(line.orderItemId, line.quantity - 1)}
                    disabled={busy || line.removed || line.quantity <= 1}
                    className="size-7 rounded-lg border border-border bg-muted text-muted-foreground disabled:opacity-40"
                  >
                    −
                  </button>
                  <span className="w-6 text-center">{toPersianDigits(line.quantity)}</span>
                  <button
                    type="button"
                    onClick={() => setQuantity(line.orderItemId, line.quantity + 1)}
                    disabled={busy || line.removed}
                    className="size-7 rounded-lg border border-border bg-muted text-muted-foreground disabled:opacity-40"
                  >
                    +
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((rows) =>
                        rows.map((row) =>
                          row.orderItemId === line.orderItemId ? { ...row, removed: !row.removed } : row,
                        ),
                      )
                    }
                    disabled={busy}
                    className="text-xs text-destructive hover:underline"
                  >
                    {line.removed ? "بازگرداندن" : "حذف قلم"}
                  </button>
                </div>
              </li>
            ))}
            {additions.map((addition, index) => (
              <li key={`addition-${index}`} className="flex items-center gap-2 py-2 text-sm">
                <span className="font-medium text-primary">
                  {menuItems.find((item) => item.id === addition.menuItemId)?.name ?? "—"}
                </span>
                <span className="text-xs text-muted-foreground">(افزوده‌شده)</span>
                <div className="ms-auto flex items-center gap-2">
                  <span className="w-6 text-center">{toPersianDigits(addition.quantity)}</span>
                  <button
                    type="button"
                    onClick={() => setAdditions((rows) => rows.filter((_, i) => i !== index))}
                    disabled={busy}
                    className="text-xs text-destructive hover:underline"
                  >
                    حذف
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <SearchableSelect
                value={addItemId}
                onChange={setAddItemId}
                ariaLabel="افزودن قلم به سفارش بسته‌شده"
                options={[{ value: "", label: "افزودن قلم…" }, ...menuItems.map((item) => ({ value: item.id, label: item.name }))]}
              />
            </div>
            <SecondaryButton
              onClick={() => {
                if (!addItemId) return;
                setAdditions((rows) => {
                  const existing = rows.findIndex((row) => row.menuItemId === addItemId);
                  if (existing === -1) return [...rows, { menuItemId: addItemId, quantity: 1 }];
                  return rows.map((row, index) =>
                    index === existing ? { ...row, quantity: row.quantity + 1 } : row,
                  );
                });
                setAddItemId("");
              }}
              disabled={busy || !addItemId}
            >
              افزودن
            </SecondaryButton>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <SearchableSelect
              value={discountType}
              onChange={(value) => setDiscountType(value as "" | "percent" | "amount")}
              ariaLabel="نوع تخفیف"
              options={[
                { value: "", label: "بدون تخفیف" },
                { value: "percent", label: "درصدی" },
                { value: "amount", label: "مبلغ ثابت" },
              ]}
            />
            {discountType ? (
              <input
                className={`${inputClass} w-32`}
                dir="ltr"
                inputMode="numeric"
                value={discountValue}
                onChange={(event) => setDiscountValue(event.target.value)}
                placeholder={discountType === "percent" ? "درصد" : "تومان"}
              />
            ) : null}
            <SearchableSelect
              value={method}
              onChange={setMethod}
              ariaLabel="روش تسویه"
              options={METHODS}
            />
          </div>

          <label className="block text-sm">
            <span className="mb-1.5 block font-medium">
              دلیل اصلاح <span className="font-normal text-muted-foreground">(الزامی، در گزارش حسابرسی ثبت می‌شود)</span>
            </span>
            <input
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="مثلاً: یک فنجان سرو نشده بود"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            <PrimaryButton
              type="button"
              onClick={() => submit("edit")}
              disabled={busy || reason.trim().length < 3 || nothingLeft}
            >
              {busy ? "در حال ثبت…" : "ثبت اصلاح"}
            </PrimaryButton>
            <SecondaryButton onClick={() => submit("void")} disabled={busy || reason.trim().length < 3}>
              حذف کامل سفارش
            </SecondaryButton>
            {nothingLeft ? (
              <p className="self-center text-xs text-muted-foreground">
                برای خالی کردن کامل سفارش، «حذف کامل سفارش» را بزنید.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {history.length > 0 ? (
        <ul className="mt-3 space-y-1 border-t border-destructive/20 pt-3 text-xs text-muted-foreground">
          {history.map((row) => (
            <li key={row.id}>
              {KIND_LABELS[row.kind]} در {toPersianDigits(row.createdAt.slice(0, 10))}
              {row.createdByName ? ` توسط ${row.createdByName}` : ""} — {formatToman(row.previousTotal)} ←{" "}
              {formatToman(row.newTotal)} — {row.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
