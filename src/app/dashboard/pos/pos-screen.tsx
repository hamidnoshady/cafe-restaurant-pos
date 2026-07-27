"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { toPersianDigits } from "@/lib/digits";
import type { KitchenTicketData } from "@/lib/kitchen-ticket-template";
import { formatToman, tomanToRial } from "@/lib/money";
import { computeOrderTotals, formatQueueLabel, type CartLine, type DiscountInput } from "@/lib/orders";
import { printKitchenTicket } from "@/lib/print-agent-client";
import { isGlobalCashierShortcutEligible, searchPosMenuItems } from "@/lib/pos-selection";
import { ModifierPicker } from "../modifier-picker";
import { apiOrQueue } from "../offline-queue";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton } from "../ui";
import { firstPrinter, usePrinters } from "../use-printers";

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
interface Courier {
  id: string;
  name: string;
  phone: string | null;
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

type OrderType = "dine_in" | "takeaway" | "delivery";

export function PosScreen() {
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [cart, setCart] = useState<CartUiLine[]>([]);
  const [orderType, setOrderType] = useState<OrderType>("dine_in");
  const [tableId, setTableId] = useState("");
  const [guestCount, setGuestCount] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryPhone, setDeliveryPhone] = useState("");
  const [deliveryFee, setDeliveryFee] = useState("");
  const [deliveryCourierId, setDeliveryCourierId] = useState("");
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">("");
  const [discountValue, setDiscountValue] = useState("");
  const [pickerItem, setPickerItem] = useState<Item | null>(null);
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ orderNumber: number | null; type: OrderType; total: number; queued: boolean } | null>(null);
  const printers = usePrinters();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const submissionInFlight = useRef(false);

  const load = useCallback(() => {
    Promise.all([
      api<MenuData>("/api/menu"),
      api<{ tables: Table[] }>("/api/tables"),
      api<{ orders: OpenOrder[] }>("/api/orders"),
      api<{ couriers: Courier[] }>("/api/couriers"),
    ]).then(([menuRes, tablesRes, ordersRes, couriersRes]) => {
      if (menuRes.ok) {
        setMenu(menuRes.data);
        if (!activeCategory && menuRes.data.categories.length > 0) {
          setActiveCategory(menuRes.data.categories.find((c) => c.is_active)?.id ?? "");
        }
      }
      if (tablesRes.ok) setTables(tablesRes.data.tables);
      if (ordersRes.ok) setOpenOrders(ordersRes.data.orders);
      if (couriersRes.ok) setCouriers(couriersRes.data.couriers);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(load, [load]);

  const occupiedTableIds = useMemo(() => new Set(openOrders.map((o) => o.table_id).filter(Boolean)), [openOrders]);
  const activeCategories = useMemo(() => menu?.categories.filter((category) => category.is_active) ?? [], [menu]);
  const visibleProducts = useMemo(() => {
    if (!menu) return [];
    const searchResults = searchPosMenuItems({
      categories: menu.categories,
      items: menu.items.filter((item): item is Item & { category_id: string } => item.category_id !== null),
      selectedCategoryId: activeCategory,
      query: searchQuery,
    });
    const itemsById = new Map(menu.items.map((item) => [item.id, item]));
    return searchResults.flatMap((result) => {
      const item = itemsById.get(result.id);
      return item ? [{ item, categoryLabel: result.categoryLabel }] : [];
    });
  }, [activeCategory, menu, searchQuery]);

  useEffect(() => {
    setSearchActiveIndex((index) => Math.min(index, Math.max(visibleProducts.length - 1, 0)));
  }, [visibleProducts.length]);

  const hasOpenOverlay = Boolean(pickerItem || reviewOpen || cartSheetOpen);
  useEffect(() => {
    function handleGlobalShortcut(event: KeyboardEvent) {
      const eligible = isGlobalCashierShortcutEligible({
        activeElement: document.activeElement,
        hasOpenDialog: hasOpenOverlay,
      });
      if (!eligible) return;

      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && /^\d$/.test(event.key)) {
        const category = activeCategories[Number(event.key) - 1];
        if (category) {
          event.preventDefault();
          setActiveCategory(category.id);
          setSearchQuery("");
          setSearchActiveIndex(0);
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && cart.length > 0) {
        event.preventDefault();
        setReviewOpen(true);
      }
    }

    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [activeCategories, cart.length, hasOpenOverlay]);

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
  // Fee is entered in Toman (like menu prices) but stored/sent in Rial.
  const feeNum = orderType === "delivery" ? tomanToRial(Math.max(0, Math.round(Number(deliveryFee) || 0))) : 0;
  const totals = computeOrderTotals(cartLines, discount, feeNum);

  async function submit() {
    if (busy || submissionInFlight.current) return;
    setError("");
    if (cart.length === 0) return setError("سبد خرید خالی است.");
    if (orderType === "dine_in" && !tableId) return setError("انتخاب میز الزامی است.");
    if (orderType === "delivery" && !deliveryAddress.trim()) return setError("برای سفارش ارسالی آدرس الزامی است.");

    submissionInFlight.current = true;
    setBusy(true);
    const orderBody = {
      type: orderType,
      tableId: orderType === "dine_in" ? tableId : undefined,
      guestCount: guestCount ? Number(guestCount) : undefined,
      discount: discountType ? { type: discountType, value: Number(discountValue) || 0 } : undefined,
      items: cart.map((l) => ({ menuItemId: l.menuItemId, quantity: l.quantity, modifierIds: l.modifierIds, note: l.note || undefined })),
      delivery:
        orderType === "delivery"
          ? {
              address: deliveryAddress.trim(),
              phone: deliveryPhone.trim() || undefined,
              fee: feeNum,
              courierId: deliveryCourierId || undefined,
            }
          : undefined,
    };
    const typeLabel = orderType === "dine_in" ? "حضوری" : orderType === "takeaway" ? "بیرون‌بر" : "ارسالی";
    const { ok, queued, data } = await apiOrQueue<{ error?: string; orderNumber?: number }>(
      "/api/orders",
      { method: "POST", body: orderBody },
      { type: "order.create", payload: orderBody, description: `سفارش ${typeLabel}` },
    );
    setBusy(false);
    submissionInFlight.current = false;
    if (!ok) return setError(errorMessage(data.error));

    setResult({ orderNumber: queued ? null : (data.orderNumber ?? null), type: orderType, total: totals.total, queued });

    // Kitchen ticket, in addition to the KDS (Phase 4) — best effort, never
    // blocks order submission on a missing/unreachable printer.
    const kitchenPrinter = firstPrinter(printers, "kitchen");
    if (!queued && kitchenPrinter) {
      const tableName = orderType === "dine_in" ? tables.find((t) => t.id === tableId)?.name : undefined;
      const label =
        orderType === "dine_in" ? (tableName ?? "میز") : orderType === "takeaway" ? "بیرون‌بر" : "ارسالی";
      const ticket: KitchenTicketData = {
        label,
        orderTypeLabel: label,
        sentAt: new Date().toISOString(),
        lines: cart.map((l) => ({ name: l.name, quantity: l.quantity, modifiersLabel: l.modifierLabel || null, note: l.note || null })),
      };
      void printKitchenTicket(kitchenPrinter.connection, ticket);
    }

    setCart([]);
    setTableId("");
    setGuestCount("");
    setDiscountType("");
    setDiscountValue("");
    setDeliveryAddress("");
    setDeliveryPhone("");
    setDeliveryFee("");
    setDeliveryCourierId("");
    load();
  }

  if (!menu) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  if (result) {
    return (
      <div className="mx-auto max-w-md rounded-2xl bg-card p-8 text-center shadow-sm">
        {result.queued ? (
          <>
            <p className="mb-2 text-sm text-primary">اتصال قطع است — سفارش ذخیره شد و پس از اتصال مجدد ارسال می‌شود.</p>
            <p className="mb-4 text-2xl font-bold text-primary">در صف ارسال</p>
          </>
        ) : (
          <>
            <p className="mb-2 text-sm text-muted-foreground">سفارش ثبت شد</p>
            <p className="mb-4 text-3xl font-bold text-primary">
              {toPersianDigits(formatQueueLabel(result.type, result.orderNumber!))}
            </p>
          </>
        )}
        <p className="mb-6 text-lg">{formatToman(result.total)}</p>
        <PrimaryButton onClick={() => setResult(null)}>سفارش جدید</PrimaryButton>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 lg:h-[calc(100vh-3rem)] lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-2">
          <label className="sr-only" htmlFor="pos-product-search">جستجوی محصول</label>
          <input
            ref={searchInputRef}
            id="pos-product-search"
            className={inputClass}
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (visibleProducts.length === 0) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const offset = event.key === "ArrowDown" ? 1 : -1;
                setSearchActiveIndex((index) => (index + offset + visibleProducts.length) % visibleProducts.length);
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const selected = visibleProducts[searchActiveIndex];
                if (selected) pickItem(selected.item);
              }
            }}
            placeholder="جستجوی محصول (/)"
            role="combobox"
            aria-expanded={visibleProducts.length > 0}
            aria-controls="pos-product-results"
            aria-activedescendant={visibleProducts[searchActiveIndex] ? `pos-product-${visibleProducts[searchActiveIndex].item.id}` : undefined}
          />
          <div className="mt-2 flex min-h-11 gap-1.5 overflow-x-auto pb-1" aria-label="دسته‌های فعال">
            {activeCategories.map((category, index) => (
              <button
                key={category.id}
                type="button"
                onClick={() => {
                  setActiveCategory(category.id);
                  setSearchQuery("");
                  setSearchActiveIndex(0);
                }}
                className={`min-h-11 shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  activeCategory === category.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted text-muted-foreground hover:text-foreground"
                }`}
                aria-keyshortcuts={`Alt+${index + 1}`}
              >
                {category.name}
              </button>
            ))}
          </div>
        </div>
        <div id="pos-product-results" role="listbox" className="grid flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto p-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {visibleProducts.map(({ item, categoryLabel }, index) => (
            <button
              key={item.id}
              id={`pos-product-${item.id}`}
              type="button"
              role="option"
              aria-selected={index === searchActiveIndex}
              onClick={() => pickItem(item)}
              className={`flex min-h-24 touch-manipulation flex-col items-start justify-between rounded-xl border p-3 text-start transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:border-primary/60 hover:bg-primary/5 hover:shadow-sm active:scale-[0.98] ${
                index === searchActiveIndex ? "border-primary ring-1 ring-primary/40" : "border-border"
              }`}
            >
              <span className="text-sm font-medium leading-snug">{item.name}</span>
              {searchQuery.trim() ? <span className="mt-1 text-xs text-muted-foreground">{categoryLabel}</span> : null}
              <span className="mt-1.5 text-sm font-semibold text-primary">{formatToman(Number(item.price))}</span>
            </button>
          ))}
          {visibleProducts.length === 0 ? <p className="col-span-full p-2 text-sm text-muted-foreground">آیتمی یافت نشد.</p> : null}
        </div>
      </div>
      {/* Cart */}
      <div className="hidden max-h-[46dvh] w-full shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm lg:flex lg:max-h-none lg:w-[22rem]">
        <div className="border-b border-border p-4">
          <ErrorBox>{error}</ErrorBox>
          <div className="mb-3 grid grid-cols-3 gap-2 text-sm font-medium">
            <button
              type="button"
              onClick={() => {
                setOrderType("dine_in");
              }}
              className={`rounded-lg py-3 transition-colors ${orderType === "dine_in" ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted hover:text-foreground"}`}
            >
              حضوری
            </button>
            <button
              type="button"
              onClick={() => {
                setOrderType("takeaway");
                setTableId("");
              }}
              className={`rounded-lg py-3 transition-colors ${orderType === "takeaway" ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted hover:text-foreground"}`}
            >
              بیرون‌بر
            </button>
            <button
              type="button"
              onClick={() => {
                setOrderType("delivery");
                setTableId("");
              }}
              className={`rounded-lg py-3 transition-colors ${orderType === "delivery" ? "bg-primary text-primary-foreground shadow-sm" : "bg-muted hover:text-foreground"}`}
            >
              ارسالی
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
                    className={`rounded-lg border px-4 py-2.5 text-sm font-medium ${
                      tableId === t.id
                        ? "border-primary bg-primary/10 text-primary"
                        : occupied
                          ? "border-border bg-muted text-muted-foreground/60"
                          : "border-input text-muted-foreground hover:border-primary/60"
                    }`}
                  >
                    {t.name}
                  </button>
                );
              })}
              {tables.length === 0 ? <p className="text-xs text-muted-foreground">میزی ثبت نشده است.</p> : null}
            </div>
          ) : null}
          {orderType === "delivery" ? (
            <div className="space-y-2">
              <textarea
                className={`${inputClass} h-auto`}
                rows={2}
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                placeholder="آدرس تحویل *"
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="tel"
                  value={deliveryPhone}
                  onChange={(e) => setDeliveryPhone(e.target.value)}
                  placeholder="تلفن مشتری"
                />
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  value={deliveryFee}
                  onChange={(e) => setDeliveryFee(e.target.value)}
                  placeholder="هزینهٔ ارسال (تومان)"
                />
              </div>
              <select
                className={inputClass}
                value={deliveryCourierId}
                onChange={(e) => setDeliveryCourierId(e.target.value)}
              >
                <option value="">تخصیص پیک بعداً (در صف ارسال)</option>
                {couriers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {cart.length === 0 ? (
            <p className="text-sm text-muted-foreground">سبد خالی است.</p>
          ) : (
            <ul className="space-y-2.5">
              {cart.map((l) => (
                <li key={l.key} className="text-sm animate-in fade-in slide-in-from-top-1 duration-150">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{l.name}</p>
                      {l.modifierLabel ? <p className="text-xs text-muted-foreground">{l.modifierLabel}</p> : null}
                    </div>
                    <p className="shrink-0 font-medium">{formatToman((l.unitPrice + l.modifierDeltas.reduce((a, b) => a + b, 0)) * l.quantity)}</p>
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="کاهش تعداد"
                      onClick={() => setQty(l.key, l.quantity - 1)}
                      className="flex size-10 items-center justify-center rounded-lg bg-muted text-lg text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground active:scale-95"
                    >
                      −
                    </button>
                    <span className="w-8 text-center text-base font-semibold">{toPersianDigits(l.quantity)}</span>
                    <button
                      type="button"
                      aria-label="افزایش تعداد"
                      onClick={() => setQty(l.key, l.quantity + 1)}
                      className="flex size-10 items-center justify-center rounded-lg bg-muted text-lg text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground active:scale-95"
                    >
                      +
                    </button>
                    <button type="button" onClick={() => removeLine(l.key)} className="ms-auto px-2 py-1 text-sm text-destructive hover:underline">
                      حذف
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-border p-4">
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
            {feeNum > 0 ? <Row label="هزینهٔ ارسال" value={formatToman(feeNum)} /> : null}
            <Row label="جمع کل" value={formatToman(totals.total)} bold />
          </dl>

          <PrimaryButton type="button" onClick={() => setReviewOpen(true)} disabled={busy || cart.length === 0}>
            {busy ? "در حال ثبت…" : "ثبت سفارش"}
          </PrimaryButton>
        </div>
      </div>

      <div className="sticky bottom-2 z-20 lg:hidden">
        <button
          type="button"
          onClick={() => setCartSheetOpen(true)}
          className="flex min-h-12 w-full items-center justify-between rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="باز کردن سبد خرید"
        >
          <span>{toPersianDigits(cart.reduce((count, line) => count + line.quantity, 0))} قلم در سبد</span>
          <span>{formatToman(totals.total)}</span>
        </button>
      </div>

      <Sheet open={cartSheetOpen} onOpenChange={setCartSheetOpen}>
        <SheetContent side="bottom" className="max-h-[88dvh] gap-0 rounded-t-2xl p-0 lg:hidden">
          <div className="border-b border-border p-4">
            <SheetTitle>سبد خرید</SheetTitle>
            <ErrorBox>{error}</ErrorBox>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm font-medium">
              {(["dine_in", "takeaway", "delivery"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setOrderType(type);
                    if (type !== "dine_in") setTableId("");
                  }}
                  className={`min-h-11 rounded-lg px-2 ${orderType === type ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                >
                  {type === "dine_in" ? "حضوری" : type === "takeaway" ? "بیرون‌بر" : "ارسالی"}
                </button>
              ))}
            </div>
            {orderType === "dine_in" ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {tables.map((table) => {
                  const occupied = occupiedTableIds.has(table.id);
                  return (
                    <button key={table.id} type="button" disabled={occupied} onClick={() => setTableId(table.id)} className={`min-h-11 rounded-lg border px-3 text-sm ${tableId === table.id ? "border-primary bg-primary/10 text-primary" : "border-input"}`}>
                      {table.name}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {orderType === "delivery" ? (
              <div className="mt-3 space-y-2">
                <textarea className={`${inputClass} h-auto`} rows={2} value={deliveryAddress} onChange={(event) => setDeliveryAddress(event.target.value)} placeholder="آدرس تحویل *" />
                <div className="grid grid-cols-2 gap-2">
                  <input className={inputClass} dir="ltr" inputMode="tel" value={deliveryPhone} onChange={(event) => setDeliveryPhone(event.target.value)} placeholder="تلفن مشتری" />
                  <input className={inputClass} dir="ltr" inputMode="numeric" value={deliveryFee} onChange={(event) => setDeliveryFee(event.target.value)} placeholder="هزینه ارسال" />
                </div>
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {cart.length === 0 ? <p className="text-sm text-muted-foreground">سبد خرید خالی است.</p> : (
              <ul className="space-y-3">
                {cart.map((line) => (
                  <li key={line.key} className="flex items-center justify-between gap-3">
                    <div className="min-w-0"><p className="font-medium">{line.name}</p>{line.modifierLabel ? <p className="text-xs text-muted-foreground">{line.modifierLabel}</p> : null}</div>
                    <div className="flex items-center gap-2">
                      <button type="button" aria-label="کاهش تعداد" onClick={() => setQty(line.key, line.quantity - 1)} className="flex size-11 items-center justify-center rounded-lg bg-muted">−</button>
                      <span className="w-5 text-center">{toPersianDigits(line.quantity)}</span>
                      <button type="button" aria-label="افزایش تعداد" onClick={() => setQty(line.key, line.quantity + 1)} className="flex size-11 items-center justify-center rounded-lg bg-muted">+</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-border p-4">
            <div className="mb-3 flex gap-2">
              <select className={inputClass} value={discountType} onChange={(event) => setDiscountType(event.target.value as "" | "percent" | "amount")} aria-label="نوع تخفیف">
                <option value="">بدون تخفیف</option><option value="percent">درصدی</option><option value="amount">مبلغ ثابت</option>
              </select>
              {discountType ? <input className={inputClass} dir="ltr" inputMode="numeric" value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} placeholder={discountType === "percent" ? "درصد" : "تومان"} aria-label="مقدار تخفیف" /> : null}
            </div>
            <Row label="جمع کل" value={formatToman(totals.total)} bold />
            <PrimaryButton type="button" onClick={() => setReviewOpen(true)} disabled={busy || cart.length === 0}>{busy ? "در حال ثبت…" : "ثبت سفارش"}</PrimaryButton>
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>بررسی سفارش</DialogTitle>
            <DialogDescription>پیش از ثبت، جزئیات سفارش را بررسی کنید.</DialogDescription>
          </DialogHeader>
          <dl className="space-y-2 text-sm">
            <Row label="نوع سفارش" value={orderType === "dine_in" ? "حضوری" : orderType === "takeaway" ? "بیرون‌بر" : "ارسالی"} />
            {orderType === "dine_in" ? <Row label="میز" value={tables.find((table) => table.id === tableId)?.name ?? "انتخاب نشده"} /> : null}
            {orderType === "delivery" ? <Row label="آدرس" value={deliveryAddress.trim() || "ثبت نشده"} /> : null}
            <Row label="تعداد اقلام" value={toPersianDigits(cart.reduce((count, line) => count + line.quantity, 0))} />
            <Row label="جمع کل" value={formatToman(totals.total)} bold />
          </dl>
          <DialogFooter>
            <button type="button" onClick={() => setReviewOpen(false)} className="min-h-11 rounded-lg border border-input px-4 text-sm font-medium">بازگشت</button>
            <button type="button" disabled={busy || cart.length === 0} onClick={() => { setReviewOpen(false); void submit(); }} className="min-h-11 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">
              {busy ? "در حال ثبت…" : "تأیید و ثبت"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    <div className={`flex justify-between ${bold ? "text-base font-bold" : "text-muted-foreground"}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
