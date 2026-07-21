"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { ORDER_ITEM_STATUS_LABELS, type OrderItemStatus } from "@/lib/order-item-status";
import { ModifierPicker } from "../modifier-picker";
import { useRealtime } from "../use-realtime";
import { api, ErrorBox, errorMessage, PrimaryButton, SecondaryButton } from "../ui";

interface Category {
  id: string;
  name: string;
  is_active: boolean;
}
interface Item {
  id: string;
  category_id: string | null;
  name: string;
  price: string | number;
  is_active: boolean;
}
interface ModifierGroup {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
}
interface Modifier {
  id: string;
  group_id: string;
  name: string;
  price_delta: string | number;
  is_active: boolean;
}
interface ItemGroupLink {
  menu_item_id: string;
  modifier_group_id: string;
}
interface MenuData {
  categories: Category[];
  items: Item[];
  modifierGroups: ModifierGroup[];
  modifiers: Modifier[];
  itemModifierGroups: ItemGroupLink[];
}
interface OrderItem {
  id: string;
  name_snapshot: string;
  quantity: number;
  status: OrderItemStatus;
  note: string | null;
}
interface OrderModifier {
  order_item_id: string;
  name_snapshot: string;
}

interface CartUiLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  modifierIds: string[];
  modifierLabel: string;
  note: string;
}

interface WaiterTable {
  id: string;
  name: string;
  status: string;
  session_id: string | null;
  guest_name: string | null;
  order_id: string | null;
}

const STATUS_BADGE: Record<OrderItemStatus, string> = {
  pending: "bg-stone-100 text-stone-600",
  sent: "bg-stone-100 text-stone-600",
  preparing: "bg-amber-100 text-amber-800",
  ready: "bg-emerald-100 text-emerald-800",
  served: "bg-stone-100 text-stone-400",
  voided: "bg-red-100 text-red-500",
};

export function TableOrderPanel({
  table,
  onBack,
  onChanged,
}: {
  table: WaiterTable;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [activeCategory, setActiveCategory] = useState("");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orderModifiers, setOrderModifiers] = useState<OrderModifier[]>([]);
  const [cart, setCart] = useState<CartUiLine[]>([]);
  const [pickerItem, setPickerItem] = useState<Item | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<MenuData>("/api/menu").then(({ ok, data }) => {
      if (ok) {
        setMenu(data);
        setActiveCategory(data.categories.find((c) => c.is_active)?.id ?? "");
      }
    });
  }, []);

  const loadOrder = useCallback(() => {
    if (!table.order_id) {
      setOrderItems([]);
      setOrderModifiers([]);
      return;
    }
    api<{ items: OrderItem[]; modifiers: OrderModifier[] }>(`/api/orders/${table.order_id}`).then(({ ok, data }) => {
      if (ok) {
        setOrderItems(data.items);
        setOrderModifiers(data.modifiers);
      }
    });
  }, [table.order_id]);
  useEffect(loadOrder, [loadOrder]);

  useRealtime(
    useCallback(
      (event) => {
        if (event.type === "order.updated" && event.orderId === table.order_id) loadOrder();
        if (event.type === "order.item_status" && event.orderId === table.order_id) loadOrder();
        if (event.type === "order.created") {
          loadOrder();
          onChanged();
        }
      },
      [loadOrder, onChanged, table.order_id],
    ),
  );

  const modsByItem = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of orderModifiers) {
      if (!map.has(m.order_item_id)) map.set(m.order_item_id, []);
      map.get(m.order_item_id)!.push(m.name_snapshot);
    }
    return map;
  }, [orderModifiers]);

  const attachedGroups = useCallback(
    (itemId: string) => {
      if (!menu) return [];
      const groupIds = menu.itemModifierGroups.filter((l) => l.menu_item_id === itemId).map((l) => l.modifier_group_id);
      return menu.modifierGroups
        .filter((g) => groupIds.includes(g.id))
        .map((g) => ({ ...g, modifiers: menu.modifiers.filter((m) => m.group_id === g.id && m.is_active) }));
    },
    [menu],
  );

  function addToCart(item: Item, selectedModifierIds: string[], note: string) {
    const modifiers = selectedModifierIds.map((id) => menu!.modifiers.find((m) => m.id === id)!);
    setCart((prev) => [
      ...prev,
      {
        key: `${item.id}-${Date.now()}-${Math.random()}`,
        menuItemId: item.id,
        name: item.name,
        unitPrice: Number(item.price),
        quantity: 1,
        modifierIds: selectedModifierIds,
        modifierLabel: modifiers.map((m) => m.name).join("، "),
        note,
      },
    ]);
  }

  function pickItem(item: Item) {
    const groups = attachedGroups(item.id);
    if (groups.length === 0) addToCart(item, [], "");
    else setPickerItem(item);
  }

  function setQty(key: string, quantity: number) {
    setCart((prev) => (quantity <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, quantity } : l))));
  }

  async function sendToKitchen() {
    setError("");
    if (cart.length === 0) return;
    setBusy(true);
    const items = cart.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierIds: l.modifierIds, note: l.note || undefined }));
    const res = table.order_id
      ? await api(`/api/orders/${table.order_id}/items`, { method: "POST", body: JSON.stringify({ items }) })
      : await api("/api/orders", { method: "POST", body: JSON.stringify({ type: "dine_in", tableId: table.id, items }) });
    setBusy(false);
    if (!res.ok) return setError(errorMessage((res.data as { error?: string }).error));
    setCart([]);
    onChanged();
    loadOrder();
  }

  async function markServed(itemId: string) {
    const res = await api(`/api/kitchen/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ status: "served" }) });
    if (res.ok) loadOrder();
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <SecondaryButton onClick={onBack}>بازگشت</SecondaryButton>
        <h2 className="text-lg font-bold">{table.name}</h2>
        {table.guest_name ? <span className="text-sm text-stone-500">{table.guest_name}</span> : null}
      </div>

      {!table.session_id ? (
        <p className="text-sm text-stone-400">این میز آزاد است. برای نشاندن مهمان از پلان سالن استفاده کنید.</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="w-full lg:w-64">
            <h3 className="mb-2 text-sm font-semibold text-stone-500">سفارش فعلی</h3>
            {orderItems.length === 0 ? (
              <p className="text-sm text-stone-400">هنوز آیتمی ثبت نشده.</p>
            ) : (
              <ul className="space-y-2">
                {orderItems.map((it) => (
                  <li key={it.id} className="rounded-xl bg-white p-3 shadow-sm">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {toPersianDigits(it.quantity)}× {it.name_snapshot}
                        </p>
                        {(modsByItem.get(it.id) ?? []).length > 0 ? (
                          <p className="text-xs text-stone-500">{(modsByItem.get(it.id) ?? []).join("، ")}</p>
                        ) : null}
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[it.status]}`}>
                        {ORDER_ITEM_STATUS_LABELS[it.status]}
                      </span>
                    </div>
                    {it.status === "ready" ? (
                      <button
                        type="button"
                        onClick={() => markServed(it.id)}
                        className="mt-2 w-full rounded-lg bg-emerald-600 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                      >
                        تحویل داده شد
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex-1 rounded-2xl bg-white p-4 shadow-sm">
            <ErrorBox>{error}</ErrorBox>
            {!menu ? (
              <p className="text-sm text-stone-400">در حال بارگذاری منو…</p>
            ) : (
              <>
                <div className="mb-3 flex gap-1 overflow-x-auto border-b border-stone-200 pb-3">
                  {menu.categories
                    .filter((c) => c.is_active)
                    .map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setActiveCategory(c.id)}
                        className={`shrink-0 rounded-lg px-4 py-2 text-sm ${
                          activeCategory === c.id ? "bg-amber-600 text-white" : "bg-stone-100 text-stone-600 hover:bg-stone-200"
                        }`}
                      >
                        {c.name}
                      </button>
                    ))}
                </div>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {menu.items
                    .filter((i) => i.is_active && i.category_id === activeCategory)
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => pickItem(item)}
                        className="flex flex-col items-start rounded-xl border border-stone-200 p-3 text-start hover:border-amber-400 hover:bg-amber-50"
                      >
                        <span className="text-sm font-medium">{item.name}</span>
                        <span className="mt-1 text-xs text-stone-500">{formatToman(Number(item.price))}</span>
                      </button>
                    ))}
                </div>

                {cart.length > 0 ? (
                  <div className="border-t border-stone-200 pt-3">
                    <ul className="mb-3 space-y-2">
                      {cart.map((l) => (
                        <li key={l.key} className="flex items-center justify-between text-sm">
                          <span>
                            {l.name}
                            {l.modifierLabel ? <span className="text-xs text-stone-500"> ({l.modifierLabel})</span> : null}
                          </span>
                          <span className="flex items-center gap-2">
                            <button type="button" onClick={() => setQty(l.key, l.quantity - 1)} className="size-6 rounded bg-stone-100">
                              −
                            </button>
                            <span className="w-4 text-center">{toPersianDigits(l.quantity)}</span>
                            <button type="button" onClick={() => setQty(l.key, l.quantity + 1)} className="size-6 rounded bg-stone-100">
                              +
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <PrimaryButton type="button" onClick={sendToKitchen} disabled={busy}>
                      {busy ? "در حال ارسال…" : "ارسال به آشپزخانه"}
                    </PrimaryButton>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {pickerItem ? (
        <ModifierPicker
          itemName={pickerItem.name}
          groups={attachedGroups(pickerItem.id)}
          onCancel={() => setPickerItem(null)}
          onConfirm={(modifierIds, note) => {
            addToCart(pickerItem, modifierIds, note);
            setPickerItem(null);
          }}
        />
      ) : null}
    </div>
  );
}
