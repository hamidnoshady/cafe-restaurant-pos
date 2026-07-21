"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { computeOrderTotals, formatQueueLabel, type CartLine, type DiscountInput } from "@/lib/orders";
import { ModifierPicker } from "../modifier-picker";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton } from "../ui";

interface Category {
  id: string;
  name: string;
  tax_rate: string | number;
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
interface Table {
  id: string;
  name: string;
  capacity: number;
}
interface OpenOrder {
  id: string;
  table_id: string | null;
}

interface CartUiLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  taxRatePercent: number;
  modifierIds: string[];
  modifierLabel: string;
  modifierDeltas: number[];
  note: string;
}

type OrderType = "dine_in" | "takeaway";

export function PosScreen() {
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [cart, setCart] = useState<CartUiLine[]>([]);
  const [orderType, setOrderType] = useState<OrderType>("dine_in");
  const [tableId, setTableId] = useState("");
  const [guestCount, setGuestCount] = useState("");
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">("");
  const [discountValue, setDiscountValue] = useState("");
  const [pickerItem, setPickerItem] = useState<Item | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ orderNumber: number; type: OrderType; total: number } | null>(null);

  const load = useCallback(() => {
    Promise.all([api<MenuData>("/api/menu"), api<{ tables: Table[] }>("/api/tables"), api<{ orders: OpenOrder[] }>("/api/orders")]).then(
      ([menuRes, tablesRes, ordersRes]) => {
        if (menuRes.ok) {
          setMenu(menuRes.data);
          if (!activeCategory && menuRes.data.categories.length > 0) {
            setActiveCategory(menuRes.data.categories.find((c) => c.is_active)?.id ?? "");
          }
        }
        if (tablesRes.ok) setTables(tablesRes.data.tables);
        if (ordersRes.ok) setOpenOrders(ordersRes.data.orders);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  const occupiedTableIds = useMemo(() => new Set(openOrders.map((o) => o.table_id).filter(Boolean)), [openOrders]);

  const attachedGroups = useCallback(
    (itemId: string): (ModifierGroup & { modifiers: Modifier[] })[] => {
      if (!menu) return [];
      const groupIds = menu.itemModifierGroups.filter((l) => l.menu_item_id === itemId).map((l) => l.modifier_group_id);
      return menu.modifierGroups
        .filter((g) => groupIds.includes(g.id))
        .map((g) => ({ ...g, modifiers: menu.modifiers.filter((m) => m.group_id === g.id && m.is_active) }));
    },
    [menu],
  );

  function categoryTaxRate(categoryId: string | null): number {
    return Number(menu?.categories.find((c) => c.id === categoryId)?.tax_rate ?? 0);
  }

  function addToCart(item: Item, selectedModifierIds: string[], note: string) {
    const modifiers = selectedModifierIds.map((id) => menu!.modifiers.find((m) => m.id === id)!);
    const modifierIds = [...selectedModifierIds].sort();
    const modifierLabel = modifiers.map((m) => m.name).join("، ");
    setCart((prev) => {
      const existing = prev.find(
        (l) =>
          l.menuItemId === item.id &&
          l.note === note &&
          l.modifierIds.length === modifierIds.length &&
          l.modifierIds.every((id, i) => id === modifierIds[i]),
      );
      if (existing) {
        return prev.map((l) => (l.key === existing.key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      const line: CartUiLine = {
        key: `${item.id}-${Date.now()}-${Math.random()}`,
        menuItemId: item.id,
        name: item.name,
        unitPrice: Number(item.price),
        quantity: 1,
        taxRatePercent: categoryTaxRate(item.category_id),
        modifierIds,
        modifierLabel,
        modifierDeltas: modifiers.map((m) => Number(m.price_delta)),
        note,
      };
      return [...prev, line];
    });
  }

  function pickItem(item: Item) {
    const groups = attachedGroups(item.id);
    if (groups.length === 0) {
      addToCart(item, [], "");
    } else {
      setPickerItem(item);
    }
  }

  function setQty(key: string, quantity: number) {
    setCart((prev) => (quantity <= 0 ? prev.filter((l) => l.key !== key) : prev.map((l) => (l.key === key ? { ...l, quantity } : l))));
  }
  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  const discount: DiscountInput = discountType ? { type: discountType, value: Number(discountValue) || 0 } : { type: null };
  const cartLines: CartLine[] = cart.map((l) => ({
    unitPrice: l.unitPrice,
    quantity: l.quantity,
    modifierDeltas: l.modifierDeltas,
    taxRatePercent: l.taxRatePercent,
  }));
  const totals = computeOrderTotals(cartLines, discount);

  async function submit() {
    setError("");
    if (cart.length === 0) return setError("سبد خرید خالی است.");
    if (orderType === "dine_in" && !tableId) return setError("انتخاب میز الزامی است.");

    setBusy(true);
    const { ok, data } = await api<{ error?: string; orderNumber?: number }>("/api/orders", {
      method: "POST",
      body: JSON.stringify({
        type: orderType,
        tableId: orderType === "dine_in" ? tableId : undefined,
        guestCount: guestCount ? Number(guestCount) : undefined,
        discount: discountType ? { type: discountType, value: Number(discountValue) || 0 } : undefined,
        items: cart.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierIds: l.modifierIds, note: l.note || undefined })),
      }),
    });
    setBusy(false);
    if (!ok) return setError(errorMessage(data.error));

    setResult({ orderNumber: data.orderNumber!, type: orderType, total: totals.total });
    setCart([]);
    setTableId("");
    setGuestCount("");
    setDiscountType("");
    setDiscountValue("");
    load();
  }

  if (!menu) return <p className="text-sm text-stone-400">در حال بارگذاری…</p>;

  if (result) {
    return (
      <div className="mx-auto max-w-md rounded-2xl bg-white p-8 text-center shadow-sm">
        <p className="mb-2 text-sm text-stone-500">سفارش ثبت شد</p>
        <p className="mb-4 text-3xl font-bold text-amber-700">
          {toPersianDigits(formatQueueLabel(result.type, result.orderNumber))}
        </p>
        <p className="mb-6 text-lg">{formatToman(result.total)}</p>
        <PrimaryButton onClick={() => setResult(null)}>سفارش جدید</PrimaryButton>
      </div>
    );
  }

  const activeCategories = menu.categories.filter((c) => c.is_active);
  const gridItems = menu.items.filter((i) => i.is_active && i.category_id === activeCategory);

  return (
    <div className="flex h-[calc(100vh-3rem)] gap-4">
      {/* Item grid */}
      <div className="flex flex-1 flex-col overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="flex gap-1 overflow-x-auto border-b border-stone-200 p-3">
          {activeCategories.map((c) => (
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
        <div className="grid flex-1 auto-rows-min grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3 lg:grid-cols-4">
          {gridItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => pickItem(item)}
              className="flex flex-col items-start rounded-xl border border-stone-200 p-3 text-start transition hover:border-amber-400 hover:bg-amber-50"
            >
              <span className="text-sm font-medium">{item.name}</span>
              <span className="mt-1 text-xs text-stone-500">{formatToman(Number(item.price))}</span>
            </button>
          ))}
          {gridItems.length === 0 ? <p className="col-span-full text-sm text-stone-400">آیتمی در این دسته نیست.</p> : null}
        </div>
      </div>

      {/* Cart */}
      <div className="flex w-96 shrink-0 flex-col overflow-hidden rounded-2xl bg-white shadow-sm">
        <div className="border-b border-stone-200 p-4">
          <ErrorBox>{error}</ErrorBox>
          <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
            <button
              type="button"
              onClick={() => {
                setOrderType("dine_in");
              }}
              className={`rounded-lg py-2 ${orderType === "dine_in" ? "bg-amber-600 text-white" : "bg-stone-100"}`}
            >
              حضوری
            </button>
            <button
              type="button"
              onClick={() => {
                setOrderType("takeaway");
                setTableId("");
              }}
              className={`rounded-lg py-2 ${orderType === "takeaway" ? "bg-amber-600 text-white" : "bg-stone-100"}`}
            >
              بیرون‌بر
            </button>
          </div>
          {orderType === "dine_in" ? (
            <div className="flex flex-wrap gap-2">
              {tables.map((t) => {
                const occupied = occupiedTableIds.has(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    disabled={occupied}
                    onClick={() => setTableId(t.id)}
                    className={`rounded-lg border px-3 py-1.5 text-xs ${
                      tableId === t.id
                        ? "border-amber-500 bg-amber-50 text-amber-800"
                        : occupied
                          ? "border-stone-200 bg-stone-100 text-stone-300"
                          : "border-stone-300 text-stone-600 hover:border-amber-400"
                    }`}
                  >
                    {t.name}
                  </button>
                );
              })}
              {tables.length === 0 ? <p className="text-xs text-stone-400">میزی ثبت نشده است.</p> : null}
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {cart.length === 0 ? (
            <p className="text-sm text-stone-400">سبد خالی است.</p>
          ) : (
            <ul className="space-y-3">
              {cart.map((l) => (
                <li key={l.key} className="text-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-medium">{l.name}</p>
                      {l.modifierLabel ? <p className="text-xs text-stone-500">{l.modifierLabel}</p> : null}
                    </div>
                    <p className="text-stone-600">{formatToman((l.unitPrice + l.modifierDeltas.reduce((a, b) => a + b, 0)) * l.quantity)}</p>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <button type="button" onClick={() => setQty(l.key, l.quantity - 1)} className="size-6 rounded bg-stone-100 text-stone-600 hover:bg-stone-200">
                      −
                    </button>
                    <span className="w-4 text-center">{toPersianDigits(l.quantity)}</span>
                    <button type="button" onClick={() => setQty(l.key, l.quantity + 1)} className="size-6 rounded bg-stone-100 text-stone-600 hover:bg-stone-200">
                      +
                    </button>
                    <button type="button" onClick={() => removeLine(l.key)} className="ms-auto text-xs text-red-600 hover:underline">
                      حذف
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-stone-200 p-4">
          <div className="mb-3 flex gap-2">
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
          </div>

          <dl className="mb-3 space-y-1 text-sm">
            <Row label="جمع جزء" value={formatToman(totals.subtotal)} />
            {totals.discount > 0 ? <Row label="تخفیف" value={`- ${formatToman(totals.discount)}`} /> : null}
            {totals.tax > 0 ? <Row label="مالیات" value={formatToman(totals.tax)} /> : null}
            <Row label="جمع کل" value={formatToman(totals.total)} bold />
          </dl>

          <PrimaryButton type="button" onClick={submit} disabled={busy || cart.length === 0}>
            {busy ? "در حال ثبت…" : "ثبت سفارش"}
          </PrimaryButton>
        </div>
      </div>

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

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "text-base font-bold" : "text-stone-600"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
