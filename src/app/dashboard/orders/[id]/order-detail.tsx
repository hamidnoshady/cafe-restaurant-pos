"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { formatQueueLabel } from "@/lib/orders";
import { ModifierPicker, type ModifierGroupWithModifiers } from "../../modifier-picker";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../../ui";

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
  const [busy, setBusy] = useState(false);

  const [addItemId, setAddItemId] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [pickerItem, setPickerItem] = useState<MenuItem | null>(null);
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">("");
  const [discountValue, setDiscountValue] = useState("");

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
    const ok = await run(() =>
      api(`/api/orders/${orderId}/items`, {
        method: "POST",
        body: JSON.stringify({ items: [{ menuItemId, quantity, modifierIds, note: note || undefined }] }),
      }),
    );
    if (ok) {
      setAddItemId("");
      setAddQty("1");
    }
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

  if (!order) return <p className="text-sm text-stone-400">در حال بارگذاری…</p>;

  const isOpen = order.status === "open";
  const editable = canEdit && isOpen;
  const activeItems = menu?.items.filter((i) => i.is_active) ?? [];

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{toPersianDigits(formatQueueLabel(order.type, order.order_number))}</h1>
          <p className="text-sm text-stone-500">
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

      <section className="mb-6 rounded-2xl bg-white p-5 shadow-sm">
        <ul className="divide-y divide-stone-100">
          {items.map((it) => {
            const mods = modifiers.filter((m) => m.order_item_id === it.id);
            const voided = it.status === "voided";
            return (
              <li key={it.id} className="py-3 text-sm">
                <div className="flex items-start justify-between">
                  <div>
                    <p className={voided ? "text-stone-400 line-through" : "font-medium"}>{it.name_snapshot}</p>
                    {mods.length > 0 ? (
                      <p className="text-xs text-stone-500">{mods.map((m) => m.name_snapshot).join("، ")}</p>
                    ) : null}
                    {voided && it.void_reason ? <p className="text-xs text-red-500">باطل: {it.void_reason}</p> : null}
                  </div>
                  <p className="text-stone-600">
                    {formatToman((Number(it.unit_price) + mods.reduce((a, m) => a + Number(m.price_delta), 0)) * it.quantity)}
                  </p>
                </div>
                {editable && !voided ? (
                  <div className="mt-1 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setItemQty(it.id, it.quantity - 1)}
                      disabled={busy || it.quantity <= 1}
                      className="size-6 rounded bg-stone-100 text-stone-600 hover:bg-stone-200 disabled:opacity-40"
                    >
                      −
                    </button>
                    <span className="w-4 text-center">{toPersianDigits(it.quantity)}</span>
                    <button
                      type="button"
                      onClick={() => setItemQty(it.id, it.quantity + 1)}
                      disabled={busy}
                      className="size-6 rounded bg-stone-100 text-stone-600 hover:bg-stone-200"
                    >
                      +
                    </button>
                    <button type="button" onClick={() => voidItem(it.id)} disabled={busy} className="ms-auto text-xs text-red-600 hover:underline">
                      ابطال قلم
                    </button>
                  </div>
                ) : !voided ? (
                  <p className="mt-1 text-xs text-stone-400">تعداد: {toPersianDigits(it.quantity)}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      {editable ? (
        <section className="mb-6 rounded-2xl bg-white p-5 shadow-sm">
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

      <section className="rounded-2xl bg-white p-5 shadow-sm">
        {editable ? (
          <div className="mb-4 flex flex-wrap items-end gap-2 border-b border-stone-100 pb-4">
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

        <dl className="space-y-1 text-sm">
          <Row label="جمع جزء" value={formatToman(Number(order.subtotal))} />
          {Number(order.discount) > 0 ? <Row label="تخفیف" value={`- ${formatToman(Number(order.discount))}`} /> : null}
          {Number(order.tax) > 0 ? <Row label="مالیات" value={formatToman(Number(order.tax))} /> : null}
          <Row label="جمع کل" value={formatToman(Number(order.total))} bold />
        </dl>
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
    <div className={`flex justify-between ${bold ? "text-base font-bold" : "text-stone-600"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
