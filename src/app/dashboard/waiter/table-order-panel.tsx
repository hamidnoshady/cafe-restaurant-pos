"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/digits";
import type { KitchenTicketData } from "@/lib/kitchen-ticket-template";
import { useMoney } from "@/components/money/money-context";
import {
  ORDER_ITEM_STATUS_LABELS,
  type OrderItemStatus,
} from "@/lib/order-item-status";
import { printKitchenTicket } from "@/lib/printing/client";
import {
  modifierNamesLabel,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import { ModifierPicker } from "../modifier-picker";
import { apiOrQueue } from "../offline-queue";
import { useRealtime } from "../use-realtime";
import {
  api,
  ErrorBox,
  errorMessage,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
} from "../ui";
import { firstPrinter, usePrinters } from "../use-printers";
import { cardClass } from "../page-chrome";
import { safeRandomId } from "@/lib/client-id";

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
  price_delta: string | number;
}

interface CartUiLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  modifierIds: string[];
  modifiers: DisplayModifier[];
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
  pending: "bg-muted text-muted-foreground",
  sent: "bg-muted text-muted-foreground",
  preparing: "bg-primary/10 text-primary",
  ready:
    "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200",
  served: "bg-muted text-muted-foreground",
  voided: "bg-destructive/10 text-destructive",
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
  const money = useMoney();
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [activeCategory, setActiveCategory] = useState("");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orderModifiers, setOrderModifiers] = useState<OrderModifier[]>([]);
  const [cart, setCart] = useState<CartUiLine[]>([]);
  const [pickerItem, setPickerItem] = useState<Item | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const printers = usePrinters();
  // Minted once for the first "send to kitchen" attempt that opens a new
  // order for this table, and reused across a manual resubmit after a failed
  // attempt (a lost response, a proxy retry) so the server's idempotency
  // check on POST /api/orders sees one id — cleared once an order actually
  // exists, since every send after that goes through the add-items branch
  // below instead.
  const clientRequestIdRef = useRef<string | null>(null);

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
    api<{ items: OrderItem[]; modifiers: OrderModifier[] }>(
      `/api/orders/${table.order_id}`,
    ).then(({ ok, data }) => {
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
        if (event.type === "order.updated" && event.orderId === table.order_id)
          loadOrder();
        if (
          event.type === "order.item_status" &&
          event.orderId === table.order_id
        )
          loadOrder();
        if (event.type === "order.created") {
          loadOrder();
          onChanged();
        }
      },
      [loadOrder, onChanged, table.order_id],
    ),
  );

  const modsByItem = useMemo(() => {
    const map = new Map<string, DisplayModifier[]>();
    for (const m of orderModifiers) {
      if (!map.has(m.order_item_id)) map.set(m.order_item_id, []);
      map.get(m.order_item_id)!.push({
        name: m.name_snapshot,
        priceDelta: Number(m.price_delta),
      });
    }
    return map;
  }, [orderModifiers]);

  const attachedGroups = useCallback(
    (itemId: string) => {
      if (!menu) return [];
      const groupIds = menu.itemModifierGroups
        .filter((l) => l.menu_item_id === itemId)
        .map((l) => l.modifier_group_id);
      return menu.modifierGroups
        .filter((g) => groupIds.includes(g.id))
        .map((g) => ({
          ...g,
          modifiers: menu.modifiers.filter(
            (m) => m.group_id === g.id && m.is_active,
          ),
        }));
    },
    [menu],
  );

  function addToCart(item: Item, selectedModifierIds: string[], note: string) {
    const modifiers: DisplayModifier[] = selectedModifierIds.map((id) => {
      const modifier = menu!.modifiers.find((m) => m.id === id)!;
      return { name: modifier.name, priceDelta: Number(modifier.price_delta) };
    });
    setCart((prev) => [
      ...prev,
      {
        key: `${item.id}-${safeRandomId()}`,
        menuItemId: item.id,
        name: item.name,
        unitPrice: Number(item.price),
        quantity: 1,
        modifierIds: selectedModifierIds,
        modifiers,
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
    setCart((prev) =>
      quantity <= 0
        ? prev.filter((l) => l.key !== key)
        : prev.map((l) => (l.key === key ? { ...l, quantity } : l)),
    );
  }

  async function sendToKitchen() {
    setError("");
    setInfo("");
    if (cart.length === 0) return;
    setBusy(true);
    const items = cart.map((l) => ({
      menuItemId: l.menuItemId,
      quantity: l.quantity,
      modifierIds: l.modifierIds,
      note: l.note || undefined,
    }));
    if (!table.order_id && !clientRequestIdRef.current) {
      clientRequestIdRef.current = safeRandomId();
    }
    const createBody = {
      type: "dine_in" as const,
      tableId: table.id,
      items,
      clientRequestId: clientRequestIdRef.current,
    };
    const res = table.order_id
      ? await apiOrQueue(
          `/api/orders/${table.order_id}/items`,
          { method: "POST", body: { items } },
          {
            type: "order.add_items",
            payload: { orderId: table.order_id, items },
            description: `افزودن قلم — ${table.name}`,
          },
        )
      : await apiOrQueue(
          "/api/orders",
          { method: "POST", body: createBody },
          {
            type: "order.create",
            payload: createBody,
            description: `سفارش حضوری — ${table.name}`,
          },
        );
    setBusy(false);
    if (!res.ok)
      return setError(errorMessage((res.data as { error?: string }).error));

    // Once queued or created, this attempt is settled one way or another —
    // the offline queue's own clientEventId owns retrying a queued one from
    // here, so the next "send to kitchen" is a new attempt and needs a fresh id.
    clientRequestIdRef.current = null;
    if (res.queued) {
      setInfo(
        "اتصال قطع است — این ارسال ذخیره شد و پس از اتصال مجدد به آشپزخانه ارسال می‌شود.",
      );
    } else {
      toast.success("سفارش به آشپزخانه ارسال شد");
      const kitchenPrinter = firstPrinter(printers, "kitchen");
      if (kitchenPrinter) {
        const ticket: KitchenTicketData = {
          label: table.name,
          orderTypeLabel: "حضوری",
          sentAt: new Date().toISOString(),
          lines: cart.map((l) => ({
            name: l.name,
            quantity: l.quantity,
            modifiersLabel: modifierNamesLabel(l.modifiers) || null,
            note: l.note || null,
          })),
        };
        void printKitchenTicket(kitchenPrinter.id, ticket);
      }
      onChanged();
      loadOrder();
    }
    setCart([]);
  }

  async function markServed(itemId: string) {
    const res = await apiOrQueue(
      `/api/kitchen/items/${itemId}`,
      { method: "PATCH", body: { status: "served" } },
      {
        type: "order_item.status",
        payload: { itemId, status: "served" },
        description: "تحویل قلم",
      },
    );
    if (res.ok && !res.queued) loadOrder();
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <SecondaryButton onClick={onBack}>بازگشت</SecondaryButton>
        <h2 className="text-lg font-bold">{table.name}</h2>
        {table.guest_name ? (
          <span className="text-sm text-muted-foreground">
            {table.guest_name}
          </span>
        ) : null}
      </div>

      {!table.session_id ? (
        <p className="text-sm text-muted-foreground">
          این میز آزاد است. برای نشاندن مهمان از پلان سالن استفاده کنید.
        </p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="w-full lg:w-64">
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              سفارش فعلی
            </h3>
            {orderItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                هنوز آیتمی ثبت نشده.
              </p>
            ) : (
              <ul className="space-y-2">
                {orderItems.map((it) => (
                  <li key={it.id} className="rounded-xl border border-border/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {toPersianDigits(it.quantity)}× {it.name_snapshot}
                        </p>
                        <ModifierBadges
                          modifiers={modsByItem.get(it.id) ?? []}
                          tone="brand"
                          className="mt-1.5"
                        />
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[it.status]}`}
                      >
                        {ORDER_ITEM_STATUS_LABELS[it.status]}
                      </span>
                    </div>
                    {it.status === "ready" ? (
                      <button
                        type="button"
                        onClick={() => markServed(it.id)}
                        className="mt-2 w-full rounded-lg bg-emerald-700 dark:bg-emerald-300 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-800 dark:hover:bg-emerald-200"
                      >
                        تحویل داده شد
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={`flex-1 ${cardClass} p-4`}>
            <ErrorBox>{error}</ErrorBox>
            {info ? <InfoBox>{info}</InfoBox> : null}
            {!menu ? (
              <LoadingSkeleton rows={5} label="در حال بارگذاری منو" />
            ) : (
              <>
                <div className="mb-3 flex gap-1 overflow-x-auto border-b border-border pb-3">
                  {menu.categories
                    .filter((c) => c.is_active)
                    .map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setActiveCategory(c.id)}
                        className={`shrink-0 rounded-lg px-4 py-2 text-sm ${
                          activeCategory === c.id
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
                        }`}
                      >
                        {c.name}
                      </button>
                    ))}
                </div>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {menu.items
                    .filter(
                      (i) => i.is_active && i.category_id === activeCategory,
                    )
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => pickItem(item)}
                        className="flex flex-col items-start rounded-xl border border-border p-3 text-start hover:border-primary/60 hover:bg-primary/5"
                      >
                        <span className="text-sm font-medium">{item.name}</span>
                        <span className="mt-1 text-xs text-muted-foreground">
                          {money.format(Number(item.price))}
                        </span>
                      </button>
                    ))}
                </div>

                {cart.length > 0 ? (
                  <div className="border-t border-border pt-3 min-h-0 overflow-y-auto">
                    <ul className="mb-3 space-y-2">
                      {cart.map((l) => (
                        <li
                          key={l.key}
                          className="flex items-start justify-between gap-3 text-sm"
                        >
                          <span className="min-w-0">
                            <span className="block font-medium">{l.name}</span>
                            <ModifierBadges
                              modifiers={l.modifiers}
                              tone="brand"
                              showCaption={false}
                              className="mt-1"
                            />
                          </span>
                          <span className="flex items-center gap-2">
                            <button
                              type="button"
                              aria-label={"کاهش تعداد " + l.name}
                              onClick={() => setQty(l.key, l.quantity - 1)}
                              className="flex size-6 items-center justify-center rounded bg-muted transition-colors hover:bg-muted-foreground/20 hover:text-foreground active:scale-95 focus-visible:ring focus-visible:ring-ring/50 outline-none"
                            >
                              −
                            </button>
                            <span className="w-4 text-center">
                              {toPersianDigits(l.quantity)}
                            </span>
                            <button
                              type="button"
                              aria-label={"افزایش تعداد " + l.name}
                              onClick={() => setQty(l.key, l.quantity + 1)}
                              className="flex size-6 items-center justify-center rounded bg-muted transition-colors hover:bg-muted-foreground/20 hover:text-foreground active:scale-95 focus-visible:ring focus-visible:ring-ring/50 outline-none"
                            >
                              +
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <PrimaryButton
                      type="button"
                      onClick={sendToKitchen}
                      disabled={busy}
                    >
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
          itemPrice={Number(pickerItem.price)}
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
