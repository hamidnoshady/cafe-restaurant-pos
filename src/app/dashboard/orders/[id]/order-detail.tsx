"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { formatQueueLabel } from "@/lib/orders";
import { kickDrawer, printReceipt } from "@/lib/print-agent-client";
import type { ReceiptData } from "@/lib/receipt-template";
import { ModifierPicker, type ModifierGroupWithModifiers } from "../../modifier-picker";
import { apiOrQueue } from "../../offline-queue";
import { api, ErrorBox, errorMessage, InfoBox, inputClass, PrimaryButton, SecondaryButton } from "../../ui";
import { firstPrinter, useBusinessInfo, usePrinters } from "../../use-printers";

const PAYMENT_METHODS: { value: "cash" | "card" | "card_to_card" | "credit"; label: string }[] = [
  { value: "cash", label: "نقدی" },
  { value: "card", label: "کارت‌خوان" },
  { value: "card_to_card", label: "کارت‌به‌کارت" },
  { value: "credit", label: "نسیه" },
];

interface Customer {
  id: string;
  name: string;
  phone: string | null;
}

interface OrderRow {
  id: string;
  order_number: number;
  type: "dine_in" | "takeaway" | "delivery";
  status: "open" | "held" | "completed" | "voided";
  table_name: string | null;
  guest_count: number | null;
  subtotal: string | number;
  discount: string | number;
  discount_type: "percent" | "amount" | null;
  discount_value: string | number | null;
  tax: string | number;
  total: string | number;
  note: string | null;
  voided_reason: string | null;
}
interface OrderItemRow {
  id: string;
  menu_item_id: string | null;
  name_snapshot: string;
  unit_price: string | number;
  quantity: number;
  status: string;
  note: string | null;
  void_reason: string | null;
}
interface ModifierRow {
  id: string;
  order_item_id: string;
  name_snapshot: string;
  price_delta: string | number;
}

interface MenuItem {
  id: string;
  category_id: string | null;
  name: string;
  price: string | number;
  is_active: boolean;
}
interface MenuData {
  items: MenuItem[];
  modifierGroups: { id: string; name: string; min_select: number; max_select: number }[];
  modifiers: { id: string; group_id: string; name: string; price_delta: string | number; is_active: boolean }[];
  itemModifierGroups: { menu_item_id: string; modifier_group_id: string }[];
}

const STATUS_LABELS: Record<string, string> = { open: "باز", held: "نگه‌داشته", completed: "تکمیل‌شده", voided: "باطل‌شده" };

export function OrderDetail({ orderId, canEdit }: { orderId: string; canEdit: boolean }) {
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [modifiers, setModifiers] = useState<ModifierRow[]>([]);
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const [addItemId, setAddItemId] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [pickerItem, setPickerItem] = useState<MenuItem | null>(null);
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">("");
  const [discountValue, setDiscountValue] = useState("");
  const [payMethod, setPayMethod] = useState<"cash" | "card" | "card_to_card" | "credit">("cash");
  const [paying, setPaying] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const printers = usePrinters();
  const business = useBusinessInfo();

  const load = useCallback(() => {
    api<{ order: OrderRow; items: OrderItemRow[]; modifiers: ModifierRow[] }>(`/api/orders/${orderId}`).then(
      ({ ok, data }) => {
        if (!ok) return;
        setOrder(data.order);
        setItems(data.items);
        setModifiers(data.modifiers);
        setDiscountType(data.order.discount_type ?? "");
        setDiscountValue(data.order.discount_value ? String(data.order.discount_value) : "");
      },
    );
  }, [orderId]);
  useEffect(load, [load]);
  useEffect(() => {
    api<MenuData>("/api/menu").then(({ ok, data }) => ok && setMenu(data));
  }, []);

  useEffect(() => {
    if (payMethod !== "credit" || selectedCustomer) {
      setCustomerResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ customers: Customer[] }>(`/api/customers?q=${encodeURIComponent(customerQuery)}`).then(
        ({ ok, data }) => ok && setCustomerResults(data.customers),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [payMethod, customerQuery, selectedCustomer]);

  async function createCustomer() {
    const name = customerQuery.trim();
    if (!name) return;
    const { ok, data } = await api<{ customer: Customer; error?: string }>("/api/customers", {
      method: "POST",
      body: JSON.stringify({ name, phone: newCustomerPhone.trim() || undefined }),
    });
    if (!ok) return setError(errorMessage(data.error));
    setSelectedCustomer(data.customer);
    setShowNewCustomer(false);
    setNewCustomerPhone("");
  }

  async function run(fn: () => Promise<{ ok: boolean; data: { error?: string } }>) {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    load();
    return true;
  }

  function attachedGroups(itemId: string): ModifierGroupWithModifiers[] {
    if (!menu) return [];
    const groupIds = menu.itemModifierGroups.filter((l) => l.menu_item_id === itemId).map((l) => l.modifier_group_id);
    return menu.modifierGroups
      .filter((g) => groupIds.includes(g.id))
      .map((g) => ({ ...g, modifiers: menu.modifiers.filter((m) => m.group_id === g.id && m.is_active) }));
  }

  function startAddItem() {
    const item = menu?.items.find((i) => i.id === addItemId);
    if (!item) return;
    const groups = attachedGroups(item.id);
    if (groups.length === 0) {
      void addItem(item.id, [], "");
    } else {
      setPickerItem(item);
    }
  }

  async function addItem(menuItemId: string, modifierIds: string[], note: string) {
    const quantity = Number(addQty) || 1;
    const items = [{ menuItemId, quantity, modifierIds, note: note || undefined }];
    setBusy(true);
    setError("");
    setInfo("");
    const { ok, queued, data } = await apiOrQueue<{ error?: string }>(
      `/api/orders/${orderId}/items`,
      { method: "POST", body: { items } },
      { type: "order.add_items", payload: { orderId, items }, description: "افزودن قلم به سفارش" },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    if (queued) {
      setInfo("اتصال قطع است — افزودن این قلم ذخیره شد و پس از اتصال مجدد ارسال می‌شود.");
    } else {
      load();
    }
    setAddItemId("");
    setAddQty("1");
  }

  async function saveDiscount() {
    await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({
          discount: discountType ? { type: discountType, value: Number(discountValue) || 0 } : { type: null },
        }),
      }),
    );
  }

  async function voidOrder() {
    const reason = window.prompt("دلیل ابطال سفارش؟") ?? "";
    await run(() => api(`/api/orders/${orderId}`, { method: "PATCH", body: JSON.stringify({ void: { reason } }) }));
  }

  async function voidItem(itemId: string) {
    const reason = window.prompt("دلیل ابطال قلم؟") ?? "";
    await run(() =>
      api(`/api/orders/${orderId}/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ void: { reason } }) }),
    );
  }

  async function setItemQty(itemId: string, quantity: number) {
    await run(() =>
      api(`/api/orders/${orderId}/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ quantity }) }),
    );
  }

  /**
   * Checkout: records the payment (POST /api/orders/[id]/pay), then — best
   * effort, never blocking checkout success — asks the local print agent to
   * print the receipt and, for cash, kick the drawer. If no receipt printer
   * is configured or the agent isn't reachable, checkout still succeeds;
   * printing just silently doesn't happen (same principle as offline
   * queueing: the business transaction and the peripheral side-effect are
   * decoupled).
   */
  async function pay() {
    if (!order) return;
    if (payMethod === "credit" && !selectedCustomer) {
      return setError(errorMessage("customer_required"));
    }
    setPaying(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/orders/${orderId}/pay`, {
      method: "POST",
      body: JSON.stringify({ method: payMethod, customerId: selectedCustomer?.id }),
    });
    setPaying(false);
    if (!ok) return setError(errorMessage(data.error));
    toast.success("پرداخت ثبت شد");
    load();

    const receiptPrinter = firstPrinter(printers, "receipt");
    if (receiptPrinter) {
      const receipt: ReceiptData = {
        business: { name: business.name, address: business.address, phone: business.phone },
        orderLabel: formatQueueLabel(order.type, order.order_number),
        orderTypeLabel: order.type === "dine_in" ? `حضوری${order.table_name ? ` — ${order.table_name}` : ""}` : "بیرون‌بر",
        issuedAt: new Date().toISOString(),
        lines: items
          .filter((it) => it.status !== "voided")
          .map((it) => {
            const mods = modifiers.filter((m) => m.order_item_id === it.id);
            const modSum = mods.reduce((a, m) => a + Number(m.price_delta), 0);
            return {
              name: it.name_snapshot,
              quantity: it.quantity,
              lineTotal: (Number(it.unit_price) + modSum) * it.quantity,
              modifiersLabel: mods.map((m) => m.name_snapshot).join("، ") || null,
            };
          }),
        subtotal: Number(order.subtotal),
        discount: Number(order.discount),
        tax: Number(order.tax),
        total: Number(order.total),
        paymentMethod: payMethod,
      };
      void printReceipt(receiptPrinter.connection, receipt);
      if (payMethod === "cash") void kickDrawer(receiptPrinter.connection);
    }
  }

  if (!order) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  const isOpen = order.status === "open";
  const editable = canEdit && isOpen;
  const activeItems = menu?.items.filter((i) => i.is_active) ?? [];

  return (
    <div className="mx-auto w-full max-w-4xl">
      <header className="mb-3 flex items-center justify-between rounded-xl border border-border/80 bg-card p-3 shadow-[0_1px_3px_rgb(15_23_42/0.04)]">
        <div>
          <h1 className="text-2xl font-bold">{toPersianDigits(formatQueueLabel(order.type, order.order_number))}</h1>
          <p className="text-sm text-muted-foreground">
            {order.type === "dine_in" ? `حضوری${order.table_name ? ` — ${order.table_name}` : ""}` : "بیرون‌بر"} ·{" "}
            {STATUS_LABELS[order.status]}
          </p>
        </div>
        {editable ? (
          <SecondaryButton onClick={voidOrder} disabled={busy}>
            ابطال سفارش
          </SecondaryButton>
        ) : null}
      </header>

      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <section className="mb-3 rounded-xl border border-border/80 bg-card p-3 shadow-[0_1px_3px_rgb(15_23_42/0.04)]">
        <ul className="divide-y divide-border/80">
          {items.map((it) => {
            const mods = modifiers.filter((m) => m.order_item_id === it.id);
            const voided = it.status === "voided";
            return (
              <li key={it.id} className="py-4 text-sm first:pt-0 last:pb-0">
                <div className="flex items-start justify-between">
                  <div>
                    <p className={voided ? "text-muted-foreground line-through" : "font-medium"}>{it.name_snapshot}</p>
                    {mods.length > 0 ? (
                      <p className="text-xs text-muted-foreground">{mods.map((m) => m.name_snapshot).join("، ")}</p>
                    ) : null}
                    {voided && it.void_reason ? <p className="text-xs text-destructive">باطل: {it.void_reason}</p> : null}
                  </div>
                  <p className="text-muted-foreground">
                    {formatToman((Number(it.unit_price) + mods.reduce((a, m) => a + Number(m.price_delta), 0)) * it.quantity)}
                  </p>
                </div>
                {editable && !voided ? (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setItemQty(it.id, it.quantity - 1)}
                      disabled={busy || it.quantity <= 1}
                      className="size-7 rounded-lg border border-border bg-muted text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="w-4 text-center">{toPersianDigits(it.quantity)}</span>
                    <button
                      type="button"
                      onClick={() => setItemQty(it.id, it.quantity + 1)}
                      disabled={busy}
                      className="size-7 rounded-lg border border-border bg-muted text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
                    >
                      +
                    </button>
                    <button type="button" onClick={() => voidItem(it.id)} disabled={busy} className="ms-auto text-xs text-destructive hover:underline">
                      ابطال قلم
                    </button>
                  </div>
                ) : !voided ? (
                  <p className="mt-1 text-xs text-muted-foreground">تعداد: {toPersianDigits(it.quantity)}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {editable ? (
        <section className="mb-3 rounded-xl border border-border/80 bg-card p-3 shadow-[0_1px_3px_rgb(15_23_42/0.04)]">
          <h2 className="mb-3 font-semibold">افزودن قلم</h2>
          <div className="flex flex-wrap gap-2">
            <select className={inputClass} value={addItemId} onChange={(e) => setAddItemId(e.target.value)}>
              <option value="">آیتم…</option>
              {activeItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
            <input
              className={`${inputClass} w-20`}
              dir="ltr"
              inputMode="numeric"
              value={addQty}
              onChange={(e) => setAddQty(e.target.value)}
            />
            <SecondaryButton onClick={startAddItem} disabled={busy || !addItemId}>
              افزودن
            </SecondaryButton>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-border/80 bg-card p-3 shadow-[0_1px_3px_rgb(15_23_42/0.04)]">
        {editable ? (
          <div className="mb-4 flex flex-wrap items-end gap-2 border-b border-border pb-4">
            <select className={inputClass} value={discountType} onChange={(e) => setDiscountType(e.target.value as "" | "percent" | "amount")}>
              <option value="">بدون تخفیف</option>
              <option value="percent">درصدی</option>
              <option value="amount">مبلغ ثابت</option>
            </select>
            {discountType ? (
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder={discountType === "percent" ? "درصد" : "تومان"}
              />
            ) : null}
            <SecondaryButton onClick={saveDiscount} disabled={busy}>
              اعمال تخفیف
            </SecondaryButton>
          </div>
        ) : null}

        <dl className="space-y-1 rounded-lg bg-muted/45 p-2.5 text-sm">
          <Row label="جمع جزء" value={formatToman(Number(order.subtotal))} />
          {Number(order.discount) > 0 ? <Row label="تخفیف" value={`- ${formatToman(Number(order.discount))}`} /> : null}
          {Number(order.tax) > 0 ? <Row label="مالیات" value={formatToman(Number(order.tax))} /> : null}
          <Row label="جمع کل" value={formatToman(Number(order.total))} bold />
        </dl>

        {editable ? (
          <div className="mt-5 border-t border-border/80 pt-5">
            <h2 className="mb-3 font-semibold">دریافت وجه و تکمیل سفارش</h2>
            <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {PAYMENT_METHODS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => {
                    setPayMethod(m.value);
                    if (m.value !== "credit") {
                      setSelectedCustomer(null);
                      setCustomerQuery("");
                    }
                  }}
                  className={`rounded-lg border px-3 py-2.5 text-sm font-medium ${payMethod === m.value ? "border-primary bg-primary text-primary-foreground shadow-sm" : "border-border bg-muted text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {payMethod === "credit" ? (
              <div className="mb-3 rounded-lg border border-border p-3">
                {selectedCustomer ? (
                  <div className="flex items-center justify-between text-sm">
                    <span>
                      {selectedCustomer.name}
                      {selectedCustomer.phone ? ` — ${toPersianDigits(selectedCustomer.phone)}` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedCustomer(null)}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      تغییر مشتری
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      className={inputClass}
                      placeholder="جستجوی نام یا شماره تماس مشتری…"
                      value={customerQuery}
                      onChange={(e) => setCustomerQuery(e.target.value)}
                    />
                    {customerResults.length > 0 ? (
                      <ul className="mt-2 max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                        {customerResults.map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              onClick={() => setSelectedCustomer(c)}
                              className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                            >
                              {c.name}
                              {c.phone ? ` — ${toPersianDigits(c.phone)}` : ""}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {customerQuery.trim() && !showNewCustomer ? (
                      <button
                        type="button"
                        onClick={() => setShowNewCustomer(true)}
                        className="mt-2 text-xs text-primary hover:underline"
                      >
                        + مشتری جدید «{customerQuery.trim()}»
                      </button>
                    ) : null}
                    {showNewCustomer ? (
                      <div className="mt-2 flex gap-2">
                        <input
                          className={inputClass}
                          dir="ltr"
                          placeholder="شماره تماس (اختیاری)"
                          value={newCustomerPhone}
                          onChange={(e) => setNewCustomerPhone(e.target.value)}
                        />
                        <SecondaryButton onClick={createCustomer} disabled={!customerQuery.trim()}>
                          ثبت مشتری
                        </SecondaryButton>
                      </div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            <PrimaryButton
              type="button"
              onClick={pay}
              disabled={paying || (payMethod === "credit" && !selectedCustomer)}
            >
              {paying ? "در حال ثبت پرداخت…" : "دریافت و تکمیل سفارش"}
            </PrimaryButton>
          </div>
        ) : null}
      </section>

      {pickerItem ? (
        <ModifierPicker
          itemName={pickerItem.name}
          groups={attachedGroups(pickerItem.id)}
          onCancel={() => setPickerItem(null)}
          onConfirm={(modifierIds, note) => {
            void addItem(pickerItem.id, modifierIds, note);
            setPickerItem(null);
          }}
        />
      ) : null}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "text-base font-bold" : "text-muted-foreground"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
