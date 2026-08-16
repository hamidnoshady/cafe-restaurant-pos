"use client";

/**
 * The whole of an order — meta, lines, add-ons, discount, tender, and the
 * closed-order amendment panel — in one dialog over the orders screen.
 *
 * It replaces the standalone /dashboard/orders/[id] page (that route now
 * redirects here). Working an order is a *step inside* the queue, not a
 * departure from it: sending the cashier to another screen lost the queue,
 * the filters, and the shift context they were reading a second earlier, and
 * cost a round trip back for every next order. Everything the page showed is
 * here — nothing is deferred to a second screen — laid out as lines on one
 * side and the money on the other so a bill can be read without scrolling.
 *
 * Styling is the app's own design system (semantic tokens + components/ui)
 * rather than the orders queue's hard-coded amber: an order document is the
 * turquoise "brand" surface that modifier-badges.tsx describes, the same one
 * the waiter panel and receipts use.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BanknoteIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  PrinterIcon,
  SettingsIcon,
  TrashIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { toPersianDigits } from "@/lib/digits";
import { formatToman, parseToRial } from "@/lib/money";
import { formatQueueLabel } from "@/lib/orders";
import { kickDrawer, printReceipt } from "@/lib/print-agent-client";
import type { ReceiptData } from "@/lib/receipt-template";
import {
  formatModifierDelta,
  linePriceBreakdown,
  modifierNamesLabel,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import {
  ModifierPicker,
  type ModifierGroupWithModifiers,
} from "../modifier-picker";
import { apiOrQueue } from "../offline-queue";
import {
  api,
  ErrorBox,
  errorMessage,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "../ui";
import { firstPrinter, useBusinessInfo, usePrinters } from "../use-printers";
import { ClosedOrderAmendment } from "./closed-order-amendment";

const PAYMENT_METHODS: {
  value: "cash" | "card" | "card_to_card" | "credit" | "snappfood";
  label: string;
}[] = [
  { value: "cash", label: "نقدی" },
  { value: "card", label: "کارت‌خوان" },
  { value: "card_to_card", label: "کارت‌به‌کارت" },
  { value: "credit", label: "نسیه" },
  { value: "snappfood", label: "اسنپ‌فود" },
];

const STATUS_LABELS: Record<string, string> = {
  open: "باز",
  held: "نگه‌داشته",
  completed: "تکمیل‌شده",
  voided: "باطل‌شده",
};

/** Solid = still costing the floor attention; outline/destructive = history. */
const STATUS_VARIANTS: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  open: "default",
  held: "secondary",
  completed: "outline",
  voided: "destructive",
};

const TYPE_LABELS: Record<string, string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
};

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
  service_charge: string | number | null;
  tax: string | number;
  total: string | number;
  tip_amount: string | number | null;
  note: string | null;
  voided_reason: string | null;
  opened_at: string;
  closed_at: string | null;
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
  /** Null only for a snapshot whose modifier row was deleted since the sale. */
  modifier_id: string | null;
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
  modifierGroups: {
    id: string;
    name: string;
    min_select: number;
    max_select: number;
  }[];
  modifiers: {
    id: string;
    group_id: string;
    name: string;
    price_delta: string | number;
    is_active: boolean;
  }[];
  itemModifierGroups: { menu_item_id: string; modifier_group_id: string }[];
}

/** Which line the add-on picker is open for, and in which mode. */
type PickerTarget =
  | { mode: "add"; menuItem: MenuItem; quantity: number }
  | {
      mode: "edit";
      menuItem: MenuItem;
      item: OrderItemRow;
      modifierIds: string[];
      note: string;
    };

function timeLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function OrderDetailModal({
  orderId,
  open,
  onOpenChange,
  canEdit,
  canAmendClosed = false,
  onChanged,
}: {
  orderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  /** may edit/remove an order that has already been paid for — a separate, back-office permission */
  canAmendClosed?: boolean;
  /** Lets the queue behind the dialog re-read itself after a paid/voided/edited order. */
  onChanged?: () => void;
}) {
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [modifiers, setModifiers] = useState<ModifierRow[]>([]);
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const [addItemId, setAddItemId] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">(
    "",
  );
  const [discountValue, setDiscountValue] = useState("");
  const [payMethod, setPayMethod] = useState<
    "cash" | "card" | "card_to_card" | "credit" | "snappfood"
  >("cash");
  const [tipInput, setTipInput] = useState("");
  const [paying, setPaying] = useState(false);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(
    null,
  );
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomerPhone, setNewCustomerPhone] = useState("");
  const printers = usePrinters();
  const business = useBusinessInfo();

  const load = useCallback(async () => {
    if (!orderId) return;
    setLoading(true);
    const { ok, data } = await api<{
      order: OrderRow;
      items: OrderItemRow[];
      modifiers: ModifierRow[];
      error?: string;
    }>(`/api/orders/${orderId}`);
    setLoading(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setOrder(data.order);
    setItems(data.items);
    setModifiers(data.modifiers);
    setDiscountType(data.order.discount_type ?? "");
    setDiscountValue(
      data.order.discount_value ? String(data.order.discount_value) : "",
    );
    setNoteDraft(data.order.note ?? "");
  }, [orderId]);

  // A dialog that is closed holds no order: reopening on a different row must
  // never flash the previous order's lines while the fetch is in flight.
  useEffect(() => {
    if (!open) return;
    setOrder(null);
    setItems([]);
    setModifiers([]);
    setError("");
    setInfo("");
    setEditingNote(false);
    setAddItemId("");
    setAddQty("1");
    setTipInput("");
    setSelectedCustomer(null);
    setCustomerQuery("");
    setShowNewCustomer(false);
    setPayMethod("cash");
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open || menu) return;
    void api<MenuData>("/api/menu").then(({ ok, data }) => ok && setMenu(data));
  }, [menu, open]);

  useEffect(() => {
    if (payMethod !== "credit" || selectedCustomer) {
      setCustomerResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void api<{ customers: Customer[] }>(
        `/api/customers?q=${encodeURIComponent(customerQuery)}`,
      ).then(({ ok, data }) => ok && setCustomerResults(data.customers));
    }, 250);
    return () => clearTimeout(timer);
  }, [payMethod, customerQuery, selectedCustomer]);

  const addOnsByItem = useMemo(() => {
    const map = new Map<
      string,
      (DisplayModifier & { modifierId: string | null })[]
    >();
    for (const modifier of modifiers) {
      const current = map.get(modifier.order_item_id) ?? [];
      current.push({
        name: modifier.name_snapshot,
        priceDelta: Number(modifier.price_delta),
        modifierId: modifier.modifier_id,
      });
      map.set(modifier.order_item_id, current);
    }
    return map;
  }, [modifiers]);

  async function createCustomer() {
    const name = customerQuery.trim();
    if (!name) return;
    const { ok, data } = await api<{ customer: Customer; error?: string }>(
      "/api/customers",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          phone: newCustomerPhone.trim() || undefined,
        }),
      },
    );
    if (!ok) return setError(errorMessage(data.error));
    setSelectedCustomer(data.customer);
    setShowNewCustomer(false);
    setNewCustomerPhone("");
  }

  async function run(
    fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
  ) {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    await load();
    onChanged?.();
    return true;
  }

  function attachedGroups(menuItemId: string): ModifierGroupWithModifiers[] {
    if (!menu) return [];
    const groupIds = menu.itemModifierGroups
      .filter((link) => link.menu_item_id === menuItemId)
      .map((link) => link.modifier_group_id);
    return menu.modifierGroups
      .filter((group) => groupIds.includes(group.id))
      .map((group) => ({
        ...group,
        modifiers: menu.modifiers.filter(
          (m) => m.group_id === group.id && m.is_active,
        ),
      }));
  }

  function startAddItem() {
    const menuItem = menu?.items.find((i) => i.id === addItemId);
    if (!menuItem) return;
    const quantity = Number(addQty) || 1;
    if (attachedGroups(menuItem.id).length === 0) {
      void addItem(menuItem.id, [], "");
    } else {
      setPicker({ mode: "add", menuItem, quantity });
    }
  }

  /** Re-open a line's add-ons in the same picker the till uses at intake. */
  function startEditAddOns(item: OrderItemRow) {
    if (!item.menu_item_id) return;
    const menuItem = menu?.items.find((i) => i.id === item.menu_item_id);
    if (!menuItem) return;
    setPicker({
      mode: "edit",
      menuItem,
      item,
      modifierIds: (addOnsByItem.get(item.id) ?? []).flatMap((addOn) =>
        addOn.modifierId ? [addOn.modifierId] : [],
      ),
      note: item.note ?? "",
    });
  }

  async function addItem(
    menuItemId: string,
    modifierIds: string[],
    note: string,
  ) {
    const quantity = Number(addQty) || 1;
    const payload = [
      { menuItemId, quantity, modifierIds, note: note || undefined },
    ];
    setBusy(true);
    setError("");
    setInfo("");
    const { ok, queued, data } = await apiOrQueue<{ error?: string }>(
      `/api/orders/${orderId}/items`,
      { method: "POST", body: { items: payload } },
      {
        type: "order.add_items",
        payload: { orderId, items: payload },
        description: "افزودن قلم به سفارش",
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    if (queued) {
      setInfo(
        "اتصال قطع است — افزودن این قلم ذخیره شد و پس از اتصال مجدد ارسال می‌شود.",
      );
    } else {
      await load();
      onChanged?.();
    }
    setAddItemId("");
    setAddQty("1");
  }

  async function saveAddOns(
    itemId: string,
    modifierIds: string[],
    note: string,
  ) {
    const saved = await run(() =>
      api(`/api/orders/${orderId}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ modifierIds, note }),
      }),
    );
    if (saved) toast.success("افزودنی‌های قلم به‌روز شد");
  }

  async function saveDiscount() {
    await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({
          discount: discountType
            ? { type: discountType, value: Number(discountValue) || 0 }
            : { type: null },
        }),
      }),
    );
  }

  async function saveNote() {
    const saved = await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ note: noteDraft }),
      }),
    );
    if (saved) setEditingNote(false);
  }

  async function voidOrder() {
    const reason = window.prompt("دلیل ابطال سفارش؟") ?? "";
    const voided = await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ void: { reason } }),
      }),
    );
    if (voided) toast.success("سفارش باطل شد");
  }

  async function voidItem(itemId: string) {
    const reason = window.prompt("دلیل ابطال قلم؟") ?? "";
    await run(() =>
      api(`/api/orders/${orderId}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ void: { reason } }),
      }),
    );
  }

  async function setItemQty(itemId: string, quantity: number) {
    await run(() =>
      api(`/api/orders/${orderId}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ quantity }),
      }),
    );
  }

  /** The receipt for this order as it stands — shared by checkout and reprint. */
  function buildReceipt(tipAmount: number, method: string): ReceiptData | null {
    if (!order) return null;
    return {
      business: {
        name: business.name,
        address: business.address,
        phone: business.phone,
      },
      orderLabel: formatQueueLabel(order.type, order.order_number),
      orderTypeLabel:
        order.type === "dine_in"
          ? `حضوری${order.table_name ? ` — ${order.table_name}` : ""}`
          : TYPE_LABELS[order.type],
      issuedAt: new Date().toISOString(),
      lines: items
        .filter((it) => it.status !== "voided")
        .map((it) => {
          const addOns = addOnsByItem.get(it.id) ?? [];
          return {
            name: it.name_snapshot,
            quantity: it.quantity,
            lineTotal: linePriceBreakdown({
              unitPrice: Number(it.unit_price),
              modifierDeltas: addOns.map((addOn) => addOn.priceDelta),
              quantity: it.quantity,
            }).total,
            modifiersLabel: modifierNamesLabel(addOns) || null,
          };
        }),
      subtotal: Number(order.subtotal),
      discount: Number(order.discount),
      tax: Number(order.tax),
      total: Number(order.total),
      tip: tipAmount,
      paymentMethod: method,
    };
  }

  /** Reprint of an already-issued bill — no payment, no drawer kick. */
  function reprint() {
    const receiptPrinter = firstPrinter(printers, "receipt");
    if (!receiptPrinter) {
      setError("چاپگر رسید تنظیم نشده است.");
      return;
    }
    const receipt = buildReceipt(Number(order?.tip_amount ?? 0), payMethod);
    if (!receipt) return;
    void printReceipt(receiptPrinter.connection, receipt);
    toast.success("رسید برای چاپ ارسال شد");
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
    let tipAmount = 0;
    if (tipInput.trim()) {
      try {
        tipAmount = parseToRial(tipInput, "toman");
      } catch {
        return setError(errorMessage("invalid_tip_amount"));
      }
    }
    setPaying(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      `/api/orders/${orderId}/pay`,
      {
        method: "POST",
        body: JSON.stringify({
          method: payMethod,
          customerId: selectedCustomer?.id,
          tipAmount,
        }),
      },
    );
    setPaying(false);
    if (!ok) return setError(errorMessage(data.error));
    toast.success("پرداخت ثبت شد");
    await load();
    onChanged?.();

    const receiptPrinter = firstPrinter(printers, "receipt");
    if (receiptPrinter) {
      const receipt = buildReceipt(tipAmount, payMethod);
      if (receipt) {
        void printReceipt(receiptPrinter.connection, receipt);
        if (payMethod === "cash") void kickDrawer(receiptPrinter.connection);
      }
    }
    setTipInput("");
  }

  const isOpenOrder = order?.status === "open";
  const editable = canEdit && isOpenOrder;
  const activeItems = menu?.items.filter((i) => i.is_active) ?? [];
  const amendable = canAmendClosed && order?.status === "completed";
  const liveItems = items.filter((it) => it.status !== "voided");
  // Voided lines are the order's history — including the ones an add-on edit
  // superseded — so they are kept, but folded away from the bill being read.
  const voidedItems = items.filter((it) => it.status === "voided");
  const itemCount = liveItems.reduce((count, it) => count + it.quantity, 0);
  /** How much of the subtotal came from add-ons — the number a customer disputes most often. */
  const addOnTotal = liveItems.reduce(
    (sum, it) =>
      sum +
      (addOnsByItem.get(it.id) ?? []).reduce(
        (lineSum, addOn) => lineSum + addOn.priceDelta,
        0,
      ) *
        it.quantity,
    0,
  );

  /**
   * One line of the order. Live lines and superseded ones render identically —
   * only where they sit differs — so a voided line still shows the add-ons and
   * price it carried, which is the point of keeping it.
   */
  function renderLine(it: OrderItemRow) {
    const addOns = addOnsByItem.get(it.id) ?? [];
    const voided = it.status === "voided";
    const breakdown = linePriceBreakdown({
      unitPrice: Number(it.unit_price),
      modifierDeltas: addOns.map((addOn) => addOn.priceDelta),
      quantity: it.quantity,
    });
    const canPickAddOns =
      editable &&
      !voided &&
      Boolean(it.menu_item_id) &&
      attachedGroups(it.menu_item_id!).length > 0;
    return (
      <li key={it.id} className="px-4 py-3 text-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p
              className={
                voided ? "text-muted-foreground line-through" : "font-bold"
              }
            >
              {it.name_snapshot}
              <span className="ms-1.5 text-xs font-semibold text-muted-foreground">
                × {toPersianDigits(it.quantity)}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {addOns.length > 0 ? (
                <>
                  {formatToman(breakdown.base, { withUnit: false })}
                  {" + "}
                  <span className="font-bold text-primary">
                    {formatModifierDelta(breakdown.addOns, { withUnit: false })}
                  </span>
                  {" = "}
                  <span className="font-bold text-foreground">
                    {formatToman(breakdown.unit)}
                  </span>{" "}
                  هر واحد
                </>
              ) : (
                `${formatToman(breakdown.base)} هر واحد`
              )}
            </p>
            <ModifierBadges
              modifiers={addOns}
              tone="brand"
              showCaption={false}
              className="mt-2"
            />
            {it.note ? (
              <p className="mt-2 text-xs text-muted-foreground">
                یادداشت: {it.note}
              </p>
            ) : null}
            {voided && it.void_reason ? (
              <p className="mt-2 text-xs text-destructive">
                باطل: {it.void_reason}
              </p>
            ) : null}
          </div>
          <p
            className={
              voided
                ? "shrink-0 text-muted-foreground line-through"
                : "shrink-0 font-bold"
            }
          >
            {formatToman(breakdown.total)}
          </p>
        </div>

        {editable && !voided ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="کاهش تعداد"
                onClick={() => setItemQty(it.id, it.quantity - 1)}
                disabled={busy || it.quantity <= 1}
              >
                <MinusIcon />
              </Button>
              <span className="w-8 text-center text-sm font-bold">
                {toPersianDigits(it.quantity)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label="افزایش تعداد"
                onClick={() => setItemQty(it.id, it.quantity + 1)}
                disabled={busy}
              >
                <PlusIcon />
              </Button>
            </div>
            {canPickAddOns ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => startEditAddOns(it)}
                disabled={busy}
              >
                <SettingsIcon data-icon="inline-start" />
                {addOns.length > 0
                  ? `افزودنی‌ها (${toPersianDigits(addOns.length)})`
                  : "افزودن افزودنی"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="ms-auto"
              onClick={() => voidItem(it.id)}
              disabled={busy}
            >
              ابطال قلم
            </Button>
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
          aria-busy={loading}
        >
          <DialogHeader className="shrink-0 gap-1 border-b border-border bg-card px-5 py-4 pe-14">
            {order ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-xl font-bold">
                    {toPersianDigits(
                      formatQueueLabel(order.type, order.order_number),
                    )}
                  </DialogTitle>
                  <Badge variant={STATUS_VARIANTS[order.status] ?? "secondary"}>
                    {STATUS_LABELS[order.status]}
                  </Badge>
                  {order.status === "open" ? (
                    <div className="ms-auto flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={reprint}
                      >
                        <PrinterIcon data-icon="inline-start" />
                        چاپ رسید
                      </Button>
                      {editable ? (
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          onClick={voidOrder}
                          disabled={busy}
                        >
                          <TrashIcon data-icon="inline-start" />
                          ابطال سفارش
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <div className="ms-auto">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={reprint}
                      >
                        <PrinterIcon data-icon="inline-start" />
                        چاپ مجدد رسید
                      </Button>
                    </div>
                  )}
                </div>
                <DialogDescription>
                  {TYPE_LABELS[order.type]}
                  {order.table_name ? ` · ${order.table_name}` : ""} · ثبت{" "}
                  {toPersianDigits(timeLabel(order.opened_at))}
                  {order.closed_at
                    ? ` · ${order.status === "voided" ? "ابطال" : "تسویه"} ${toPersianDigits(timeLabel(order.closed_at))}`
                    : ""}
                </DialogDescription>
              </>
            ) : (
              <>
                <DialogTitle className="text-xl font-bold">
                  جزئیات سفارش
                </DialogTitle>
                <DialogDescription>
                  در حال بارگذاری اطلاعات سفارش…
                </DialogDescription>
              </>
            )}
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto bg-background px-5 py-4">
            {!order ? (
              <div
                className="space-y-3"
                aria-label="در حال بارگذاری جزئیات سفارش"
              >
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-24 w-full rounded-xl" />
              </div>
            ) : (
              <>
                <ErrorBox>{error}</ErrorBox>
                {info ? <InfoBox>{info}</InfoBox> : null}
                {order.status === "voided" && order.voided_reason ? (
                  <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                    دلیل ابطال: {order.voided_reason}
                  </p>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
                  <div className="min-w-0 space-y-4">
                    <section className="rounded-xl border border-border bg-card shadow-xs">
                      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                        <h3 className="text-sm font-bold">اقلام سفارش</h3>
                        <span className="text-xs text-muted-foreground">
                          {toPersianDigits(itemCount)} قلم
                        </span>
                      </div>
                      {items.length === 0 ? (
                        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                          قلمی برای این سفارش ثبت نشده است.
                        </p>
                      ) : (
                        <ul className="divide-y divide-border">
                          {liveItems.map(renderLine)}
                        </ul>
                      )}
                      {voidedItems.length > 0 ? (
                        <details className="border-t border-border">
                          <summary className="cursor-pointer px-4 py-3 text-xs font-semibold text-muted-foreground marker:text-muted-foreground hover:text-foreground">
                            اقلام باطل‌شده (
                            {toPersianDigits(voidedItems.length)} مورد)
                          </summary>
                          <ul className="divide-y divide-border border-t border-border">
                            {voidedItems.map(renderLine)}
                          </ul>
                        </details>
                      ) : null}
                    </section>

                    {editable ? (
                      <section className="rounded-xl border border-border bg-card p-4 shadow-xs">
                        <h3 className="mb-3 text-sm font-bold">افزودن قلم</h3>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="min-w-56 flex-1">
                            <SearchableSelect
                              value={addItemId}
                              onChange={setAddItemId}
                              ariaLabel="انتخاب آیتم برای افزودن"
                              options={[
                                { value: "", label: "آیتم…" },
                                ...activeItems.map((i) => ({
                                  value: i.id,
                                  label: i.name,
                                })),
                              ]}
                            />
                          </div>
                          <input
                            className={`${inputClass} w-20`}
                            dir="ltr"
                            inputMode="numeric"
                            aria-label="تعداد"
                            value={addQty}
                            onChange={(event) => setAddQty(event.target.value)}
                          />
                          <Button
                            type="button"
                            onClick={startAddItem}
                            disabled={busy || !addItemId}
                          >
                            <PlusIcon data-icon="inline-start" />
                            افزودن
                          </Button>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          آیتم‌هایی که گروه افزودنی دارند، پیش از ثبت پنجرهٔ
                          انتخاب افزودنی را باز می‌کنند.
                        </p>
                      </section>
                    ) : null}

                    <section className="rounded-xl border border-border bg-card p-4 shadow-xs">
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-sm font-bold">یادداشت سفارش</h3>
                        {editable && !editingNote ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingNote(true)}
                          >
                            <PencilIcon data-icon="inline-start" />
                            {order.note ? "ویرایش" : "افزودن یادداشت"}
                          </Button>
                        ) : null}
                      </div>
                      {editingNote ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <input
                            className={`${inputClass} flex-1`}
                            value={noteDraft}
                            onChange={(event) =>
                              setNoteDraft(event.target.value)
                            }
                            placeholder="مثلاً: مهمان عجله دارد"
                          />
                          <Button
                            type="button"
                            onClick={saveNote}
                            disabled={busy}
                          >
                            ذخیره
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => {
                              setNoteDraft(order.note ?? "");
                              setEditingNote(false);
                            }}
                            disabled={busy}
                          >
                            انصراف
                          </Button>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {order.note || "یادداشتی ثبت نشده است."}
                        </p>
                      )}
                    </section>
                  </div>

                  <div className="min-w-0 space-y-4">
                    <section className="rounded-xl border border-border bg-card p-4 shadow-xs">
                      <h3 className="mb-3 text-sm font-bold">مشخصات سفارش</h3>
                      <dl className="grid grid-cols-2 gap-2 text-sm">
                        <Fact
                          label="نوع سفارش"
                          value={TYPE_LABELS[order.type]}
                        />
                        {order.table_name ? (
                          <Fact label="میز" value={order.table_name} />
                        ) : null}
                        {order.guest_count ? (
                          <Fact
                            label="تعداد مهمان"
                            value={toPersianDigits(order.guest_count)}
                          />
                        ) : null}
                        <Fact
                          label="زمان ثبت"
                          value={toPersianDigits(timeLabel(order.opened_at))}
                        />
                        {order.closed_at ? (
                          <Fact
                            label={
                              order.status === "voided"
                                ? "زمان ابطال"
                                : "زمان تسویه"
                            }
                            value={toPersianDigits(timeLabel(order.closed_at))}
                          />
                        ) : null}
                        {Number(order.tip_amount ?? 0) > 0 ? (
                          <Fact
                            label="انعام"
                            value={formatToman(Number(order.tip_amount))}
                          />
                        ) : null}
                      </dl>
                    </section>

                    <section className="rounded-xl border border-border bg-card p-4 shadow-xs">
                      {editable ? (
                        <div className="mb-4 border-b border-border pb-4">
                          <h3 className="mb-2 text-sm font-bold">تخفیف</h3>
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="min-w-32 flex-1">
                              <SearchableSelect
                                value={discountType}
                                onChange={(value) =>
                                  setDiscountType(
                                    value as "" | "percent" | "amount",
                                  )
                                }
                                ariaLabel="نوع تخفیف"
                                options={[
                                  { value: "", label: "بدون تخفیف" },
                                  { value: "percent", label: "درصدی" },
                                  { value: "amount", label: "مبلغ ثابت" },
                                ]}
                              />
                            </div>
                            {discountType ? (
                              <input
                                className={`${inputClass} w-24`}
                                dir="ltr"
                                inputMode="numeric"
                                aria-label="مقدار تخفیف"
                                value={discountValue}
                                onChange={(event) =>
                                  setDiscountValue(event.target.value)
                                }
                                placeholder={
                                  discountType === "percent" ? "درصد" : "تومان"
                                }
                              />
                            ) : null}
                            <SecondaryButton
                              onClick={saveDiscount}
                              disabled={busy}
                            >
                              اعمال
                            </SecondaryButton>
                          </div>
                        </div>
                      ) : null}

                      <dl className="space-y-1.5 text-sm">
                        <Row
                          label="جمع جزء"
                          value={formatToman(Number(order.subtotal))}
                        />
                        {addOnTotal !== 0 ? (
                          <Row
                            label="از این مبلغ، افزودنی‌ها"
                            value={formatModifierDelta(addOnTotal)}
                          />
                        ) : null}
                        {Number(order.discount) > 0 ? (
                          <Row
                            label="تخفیف"
                            value={`- ${formatToman(Number(order.discount))}`}
                          />
                        ) : null}
                        {Number(order.service_charge ?? 0) > 0 ? (
                          <Row
                            label="هزینهٔ ارسال"
                            value={formatToman(Number(order.service_charge))}
                          />
                        ) : null}
                        {Number(order.tax) > 0 ? (
                          <Row
                            label="مالیات"
                            value={formatToman(Number(order.tax))}
                          />
                        ) : null}
                        <div className="mt-2 flex items-baseline justify-between rounded-lg bg-primary/5 px-3 py-2">
                          <dt className="text-sm font-bold">جمع کل</dt>
                          <dd className="text-lg font-bold text-primary">
                            {formatToman(Number(order.total))}
                          </dd>
                        </div>
                      </dl>
                    </section>

                    {editable ? (
                      <section className="rounded-xl border border-border bg-card p-4 shadow-xs">
                        <h3 className="mb-3 text-sm font-bold">
                          دریافت وجه و تکمیل سفارش
                        </h3>
                        <div className="mb-3 grid grid-cols-2 gap-2">
                          {PAYMENT_METHODS.map((method) => (
                            <Button
                              key={method.value}
                              type="button"
                              variant={
                                payMethod === method.value
                                  ? "default"
                                  : "outline"
                              }
                              onClick={() => {
                                setPayMethod(method.value);
                                if (method.value !== "credit") {
                                  setSelectedCustomer(null);
                                  setCustomerQuery("");
                                }
                              }}
                            >
                              {method.label}
                            </Button>
                          ))}
                        </div>

                        <label className="mb-3 block text-sm">
                          <span className="mb-1.5 block font-medium">
                            انعام{" "}
                            <span className="font-normal text-muted-foreground">
                              (اختیاری، تومان)
                            </span>
                          </span>
                          <input
                            className={inputClass}
                            dir="ltr"
                            inputMode="numeric"
                            value={tipInput}
                            onChange={(event) =>
                              setTipInput(event.target.value)
                            }
                            placeholder="۰"
                          />
                        </label>

                        {payMethod === "credit" ? (
                          <div className="mb-3 rounded-lg border border-border p-3">
                            {selectedCustomer ? (
                              <div className="flex items-center justify-between gap-2 text-sm">
                                <span className="min-w-0 truncate">
                                  {selectedCustomer.name}
                                  {selectedCustomer.phone
                                    ? ` — ${toPersianDigits(selectedCustomer.phone)}`
                                    : ""}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="xs"
                                  onClick={() => setSelectedCustomer(null)}
                                >
                                  تغییر مشتری
                                </Button>
                              </div>
                            ) : (
                              <>
                                <input
                                  className={inputClass}
                                  placeholder="جستجوی نام یا شماره تماس مشتری…"
                                  value={customerQuery}
                                  onChange={(event) =>
                                    setCustomerQuery(event.target.value)
                                  }
                                />
                                {customerResults.length > 0 ? (
                                  <ul className="mt-2 max-h-40 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                                    {customerResults.map((customer) => (
                                      <li key={customer.id}>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setSelectedCustomer(customer)
                                          }
                                          className="block w-full px-3 py-2 text-start text-sm hover:bg-muted"
                                        >
                                          {customer.name}
                                          {customer.phone
                                            ? ` — ${toPersianDigits(customer.phone)}`
                                            : ""}
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                                {customerQuery.trim() && !showNewCustomer ? (
                                  <Button
                                    type="button"
                                    variant="link"
                                    size="sm"
                                    className="mt-2 px-0"
                                    onClick={() => setShowNewCustomer(true)}
                                  >
                                    + مشتری جدید «{customerQuery.trim()}»
                                  </Button>
                                ) : null}
                                {showNewCustomer ? (
                                  <div className="mt-2 flex gap-2">
                                    <input
                                      className={inputClass}
                                      dir="ltr"
                                      placeholder="شماره تماس (اختیاری)"
                                      value={newCustomerPhone}
                                      onChange={(event) =>
                                        setNewCustomerPhone(event.target.value)
                                      }
                                    />
                                    <SecondaryButton
                                      onClick={createCustomer}
                                      disabled={!customerQuery.trim()}
                                    >
                                      ثبت
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
                          disabled={
                            paying ||
                            (payMethod === "credit" && !selectedCustomer)
                          }
                        >
                          <BanknoteIcon data-icon="inline-start" />
                          {paying
                            ? "در حال ثبت پرداخت…"
                            : `دریافت ${formatToman(Number(order.total))} و تکمیل`}
                        </PrimaryButton>
                      </section>
                    ) : null}
                  </div>
                </div>

                {amendable && orderId ? (
                  <ClosedOrderAmendment
                    orderId={orderId}
                    items={items.map((it) => ({
                      id: it.id,
                      name: it.name_snapshot,
                      quantity: it.quantity,
                      status: it.status,
                    }))}
                    menuItems={activeItems.map((item) => ({
                      id: item.id,
                      name: item.name,
                    }))}
                    discountType={order.discount_type}
                    discountValue={
                      order.discount_value === null
                        ? null
                        : Number(order.discount_value)
                    }
                    onDone={() => {
                      void load();
                      onChanged?.();
                    }}
                  />
                ) : null}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {picker ? (
        <ModifierPicker
          itemName={picker.menuItem.name}
          itemPrice={Number(picker.menuItem.price)}
          quantity={
            picker.mode === "add" ? picker.quantity : picker.item.quantity
          }
          groups={attachedGroups(picker.menuItem.id)}
          initialModifierIds={
            picker.mode === "edit" ? picker.modifierIds : undefined
          }
          initialNote={picker.mode === "edit" ? picker.note : ""}
          confirmLabel={
            picker.mode === "edit" ? "ذخیرهٔ افزودنی‌ها" : undefined
          }
          onCancel={() => setPicker(null)}
          onConfirm={(modifierIds, note) => {
            if (picker.mode === "add") {
              void addItem(picker.menuItem.id, modifierIds, note);
            } else {
              void saveAddOns(picker.item.id, modifierIds, note);
            }
            setPicker(null);
          }}
        />
      ) : null}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/60 p-2.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-bold">{value}</dd>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-muted-foreground">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
