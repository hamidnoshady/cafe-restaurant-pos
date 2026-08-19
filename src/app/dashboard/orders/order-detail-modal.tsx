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
 * here — nothing is deferred to a second screen.
 *
 * It is drawn in the operations design language the rest of the floor-facing
 * app uses (the dashboard overview, the POS, the KDS, and the orders queue
 * behind it): cream canvas, white cards on #EAE8E2 hairlines, the amber
 * #E9A11B accent, pill status chips, and no control smaller than a 44–48px
 * touch target. Add-on chips are `tone="amber"` for the same reason — this is
 * a cash-desk surface, not a document one.
 *
 * Layout is one column on a phone and two from `lg` up (lines on one side,
 * money on the other); the line list itself becomes a real table from `md` up
 * and stays a stack of cards below that.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BanknoteIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  PrinterIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { formatToman, parseToRial } from "@/lib/money";
import {
  draftNeedsCustomer,
  draftOpensDrawer,
  draftReceiptPayments,
  emptyPaymentDraft,
  paymentDraftBody,
  type PaymentDraft,
} from "@/lib/payment-draft";
import { PaymentWays, usePaymentMethods } from "../payment-ways";
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
import { api, errorMessage } from "../ui";
import { firstPrinter, useBusinessInfo, usePrinters } from "../use-printers";
import { ClosedOrderAmendment } from "./closed-order-amendment";
import {
  CARD,
  DANGER_BUTTON,
  FOCUS,
  OPS_INPUT,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  STEPPER_BUTTON,
} from "./ops-styles";

/**
 * The columns the line table's header and its rows share, so the two align:
 * قلم | تعداد | مبلغ | (void). Below `md` the same children reflow into two
 * rows — name + amount, then the controls — which is why every cell carries an
 * explicit `md:col-start`/`md:row-start` rather than relying on source order.
 */
const LINE_GRID =
  "md:grid md:grid-cols-[minmax(0,1fr)_8.5rem_9rem_2.75rem] md:gap-3";

/** The same chips the dashboard overview and the queue use, so a status reads alike everywhere. */
const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  open: {
    label: "باز",
    className: "border-[#E9A11B]/25 bg-[#FFF6E6] text-[#9B6700]",
  },
  held: {
    label: "نگه‌داشته",
    className: "border-[#EAE8E2] bg-[#F8F7F4] text-[#77756F]",
  },
  completed: {
    label: "تکمیل‌شده",
    className: "border-[#36B56A]/25 bg-[#EFFAF3] text-[#23834A]",
  },
  voided: {
    label: "باطل‌شده",
    className: "border-[#E5CCC5] bg-[#FFF7F4] text-[#9E4437]",
  },
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
  /** Whom the sale is attributed to — set at the till, by a credit checkout, or by a backdated sale. */
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
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
  return toPersianDigits(
    new Intl.DateTimeFormat("fa-IR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date),
  );
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
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const [addItemId, setAddItemId] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [showVoided, setShowVoided] = useState(false);
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">(
    "",
  );
  const [discountValue, setDiscountValue] = useState("");
  // The business's own payment ways, and what the cashier has chosen — a
  // single way or a split across several (src/lib/payment-draft.ts). Shared
  // with the POS through <PaymentWays>, so the two checkouts stay identical.
  const { methods: paymentMethods } = usePaymentMethods();
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>(() => emptyPaymentDraft([]));
  const needsCustomer = draftNeedsCustomer(paymentDraft, paymentMethods);
  // The ways land a render or two after the dialog opens, so the draft starts
  // pointing at nothing; this settles it on the first way once they arrive.
  useEffect(() => {
    setPaymentDraft((draft) =>
      paymentMethods.some((method) => method.id === draft.methodId) ? draft : emptyPaymentDraft(paymentMethods),
    );
  }, [paymentMethods]);
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
    const { ok, data } = await api<{
      order: OrderRow;
      items: OrderItemRow[];
      modifiers: ModifierRow[];
      error?: string;
    }>(`/api/orders/${orderId}`);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setOrder(data.order);
    setItems(data.items);
    setModifiers(data.modifiers);
    // An order that already names a customer keeps naming them: the credit
    // checkout below re-uses this selection instead of making the cashier
    // search the directory again for a customer the order already has.
    // Only when nothing is picked yet — `load()` also runs after an item edit,
    // and must not throw away a pick the cashier just made mid-checkout. The
    // open-effect below clears it, so each fresh dialog starts from the order.
    setSelectedCustomer(
      (current) =>
        current ??
        (data.order.customer_id && data.order.customer_name
          ? {
              id: data.order.customer_id,
              name: data.order.customer_name,
              phone: data.order.customer_phone,
            }
          : null),
    );
    setDiscountType(data.order.discount_type ?? "");
    setDiscountValue(
      data.order.discount_value ? String(data.order.discount_value) : "",
    );
    setNoteDraft(data.order.note ?? "");
  }, [orderId]);

  // A closed dialog holds no order: reopening on a different row must never
  // flash the previous order's lines while the fetch is in flight.
  useEffect(() => {
    if (!open) return;
    setOrder(null);
    setItems([]);
    setModifiers([]);
    setError("");
    setInfo("");
    setEditingNote(false);
    setShowVoided(false);
    setAddItemId("");
    setAddQty("1");
    setTipInput("");
    setSelectedCustomer(null);
    setCustomerQuery("");
    setShowNewCustomer(false);
    setPaymentDraft(emptyPaymentDraft(paymentMethods));
    void load();
  }, [load, open]);

  useEffect(() => {
    if (!open || menu) return;
    void api<MenuData>("/api/menu").then(({ ok, data }) => ok && setMenu(data));
  }, [menu, open]);

  useEffect(() => {
    if (!needsCustomer || selectedCustomer) {
      setCustomerResults([]);
      return;
    }
    const timer = setTimeout(() => {
      void api<{ customers: Customer[] }>(
        `/api/customers?q=${encodeURIComponent(customerQuery)}`,
      ).then(({ ok, data }) => ok && setCustomerResults(data.customers));
    }, 250);
    return () => clearTimeout(timer);
  }, [needsCustomer, customerQuery, selectedCustomer]);

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
  function buildReceipt(tipAmount: number, payments: { label: string; amount: number }[]): ReceiptData | null {
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
      payments,
    };
  }

  /** Reprint of an already-issued bill — no payment, no drawer kick. */
  function reprint() {
    const receiptPrinter = firstPrinter(printers, "receipt");
    if (!receiptPrinter) {
      setError("چاپگر رسید تنظیم نشده است.");
      return;
    }
    const receipt = buildReceipt(
      Number(order?.tip_amount ?? 0),
      draftReceiptPayments(paymentDraft, paymentMethods, Number(order?.total ?? 0)),
    );
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
    if (needsCustomer && !selectedCustomer) {
      return setError(errorMessage("customer_required"));
    }
    const total = Number(order.total);
    const built = paymentDraftBody(paymentDraft, paymentMethods, total);
    if (!built.ok) return setError(errorMessage(built.error));
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
          payments: built.value,
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
      const receipt = buildReceipt(tipAmount, draftReceiptPayments(paymentDraft, paymentMethods, total));
      if (receipt) {
        void printReceipt(receiptPrinter.connection, receipt);
        // Any cash slice opens the drawer, not just an all-cash bill.
        if (draftOpensDrawer(paymentDraft, paymentMethods)) void kickDrawer(receiptPrinter.connection);
      }
    }
    setTipInput("");
  }

  const editable = canEdit && order?.status === "open";
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
  const statusChip = order
    ? (STATUS_CHIP[order.status] ?? STATUS_CHIP.held)
    : null;

  /**
   * One line of the order. Live and superseded lines render identically —
   * only where they sit differs — so a voided line still shows the add-ons
   * and the price it carried, which is the point of keeping it.
   *
   * The grid is the responsive part: name and amount side by side on a phone
   * with the controls on their own row beneath, and a single table row from
   * `md` up, on the columns the header above it uses.
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
      <li
        key={it.id}
        className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 border-b border-[#F1EFEA] px-4 py-3.5 last:border-b-0 md:items-center ${LINE_GRID}`}
      >
        <div className="col-start-1 row-start-1 min-w-0 md:row-start-1">
          <p
            className={`truncate text-sm font-semibold ${voided ? "text-[#8B8A85] line-through" : "text-[#252522]"}`}
          >
            {it.name_snapshot}
          </p>
          <p className="mt-1 text-xs text-[#77756F]">
            {formatToman(breakdown.unit)} هر واحد
            {addOns.length > 0 ? (
              <span className="text-[#B97905]">
                {" "}
                — شامل{" "}
                {formatModifierDelta(breakdown.addOns, {
                  withUnit: false,
                })}{" "}
                افزودنی
              </span>
            ) : null}
          </p>

          {addOns.length > 0 || canPickAddOns ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <ModifierBadges
                modifiers={addOns}
                tone="amber"
                showCaption={false}
              />
              {canPickAddOns ? (
                <button
                  type="button"
                  onClick={() => startEditAddOns(it)}
                  disabled={busy}
                  className={`inline-flex min-h-9 items-center gap-1 rounded-lg border border-dashed border-[#F0D39C] bg-[#FFFCF5] px-2.5 text-[11px] font-bold text-[#9B6700] transition-colors hover:bg-[#FFF9EE] ${FOCUS} disabled:opacity-55`}
                >
                  {addOns.length > 0 ? (
                    <>
                      <PencilIcon className="size-3" aria-hidden="true" />
                      ویرایش افزودنی‌ها
                    </>
                  ) : (
                    <>
                      <PlusIcon className="size-3" aria-hidden="true" />
                      افزودنی
                    </>
                  )}
                </button>
              ) : null}
            </div>
          ) : null}

          {it.note ? (
            <p className="mt-2 text-xs text-[#77756F]">یادداشت: {it.note}</p>
          ) : null}
          {voided && it.void_reason ? (
            <p className="mt-2 text-xs font-medium text-[#9E4437]">
              باطل: {it.void_reason}
            </p>
          ) : null}
        </div>

        <p
          className={`col-start-2 row-start-1 justify-self-end whitespace-nowrap text-sm font-bold tabular-nums md:col-start-3 md:justify-self-stretch md:text-end ${voided ? "text-[#8B8A85] line-through" : "text-[#252522]"}`}
        >
          {formatToman(breakdown.total)}
        </p>

        <div className="col-start-1 row-start-2 flex items-center gap-1.5 md:col-start-2 md:row-start-1">
          {editable && !voided ? (
            <>
              <button
                type="button"
                aria-label="کاهش تعداد"
                onClick={() => setItemQty(it.id, it.quantity - 1)}
                disabled={busy || it.quantity <= 1}
                className={STEPPER_BUTTON}
              >
                <MinusIcon className="size-4" aria-hidden="true" />
              </button>
              <span className="w-7 text-center text-sm font-bold tabular-nums text-[#252522]">
                {toPersianDigits(it.quantity)}
              </span>
              <button
                type="button"
                aria-label="افزایش تعداد"
                onClick={() => setItemQty(it.id, it.quantity + 1)}
                disabled={busy}
                className={STEPPER_BUTTON}
              >
                <PlusIcon className="size-4" aria-hidden="true" />
              </button>
            </>
          ) : (
            <span className="text-xs text-[#77756F]">
              تعداد{" "}
              <span className="font-bold tabular-nums">
                {toPersianDigits(it.quantity)}
              </span>
            </span>
          )}
        </div>

        {editable && !voided ? (
          <button
            type="button"
            aria-label={`ابطال ${it.name_snapshot}`}
            title="ابطال قلم"
            onClick={() => voidItem(it.id)}
            disabled={busy}
            className={`${DANGER_BUTTON} col-start-2 row-start-2 size-11 justify-self-end px-0 md:col-start-4 md:row-start-1 md:justify-self-center`}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </li>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none bg-[#FCFCFA] p-0 ring-0 sm:h-auto sm:max-h-[92dvh] sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:rounded-2xl sm:ring-1 sm:ring-[#EAE8E2]"
        >
          <DialogHeader className="shrink-0 gap-0 border-b border-[#EAE8E2] bg-white px-4 py-3 sm:px-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="font-sans text-lg font-bold text-[#252522] sm:text-xl">
                    {order
                      ? toPersianDigits(
                          formatQueueLabel(order.type, order.order_number),
                        )
                      : "جزئیات سفارش"}
                  </DialogTitle>
                  {statusChip ? (
                    <span
                      className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-medium ${statusChip.className}`}
                    >
                      {statusChip.label}
                    </span>
                  ) : null}
                  {/* Beside the order number rather than only down in the facts
                      list: on a phone the facts are a scroll away, and whose
                      bill this is belongs with what bill it is. */}
                  {order?.customer_name ? (
                    <span className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border border-[#F2D097] bg-[#FFF9EE] px-2.5 text-xs font-bold text-[#9B6700]">
                      <UserIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{order.customer_name}</span>
                    </span>
                  ) : null}
                </div>
                <DialogDescription className="mt-1 text-xs text-[#77756F]">
                  {order ? (
                    <>
                      {TYPE_LABELS[order.type]}
                      {order.table_name ? ` · ${order.table_name}` : ""} · ثبت{" "}
                      {timeLabel(order.opened_at)}
                      {order.closed_at
                        ? ` · ${order.status === "voided" ? "ابطال" : "تسویه"} ${timeLabel(order.closed_at)}`
                        : ""}
                    </>
                  ) : (
                    "در حال بارگذاری اطلاعات سفارش…"
                  )}
                </DialogDescription>
              </div>
              {/* Actions sit beside the title from `sm` up and drop to their
                  own row on a phone, where a third button would not fit. */}
              <div className="flex shrink-0 items-center gap-2">
                {/* The wrapper carries `hidden`, not the buttons: a `hidden`
                    utility on an element that also sets `inline-flex` is a
                    coin toss between two same-specificity display rules. */}
                {order ? (
                  <div className="hidden items-center gap-2 sm:flex">
                    <button
                      type="button"
                      onClick={reprint}
                      className={SECONDARY_BUTTON}
                    >
                      <PrinterIcon className="size-4" aria-hidden="true" />
                      {order.status === "open" ? "چاپ رسید" : "چاپ مجدد"}
                    </button>
                    {editable ? (
                      <button
                        type="button"
                        onClick={voidOrder}
                        disabled={busy}
                        className={DANGER_BUTTON}
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                        ابطال سفارش
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="بستن"
                  className={`flex size-11 shrink-0 items-center justify-center rounded-xl border border-[#EAE8E2] bg-white text-[#5E5B55] transition-colors hover:bg-[#FCFCFA] ${FOCUS} active:scale-[0.95]`}
                >
                  <XIcon className="size-4" aria-hidden="true" />
                </button>
              </div>
            </div>

            {order ? (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:hidden">
                <button
                  type="button"
                  onClick={reprint}
                  className={`${SECONDARY_BUTTON} min-h-12`}
                >
                  <PrinterIcon className="size-4" aria-hidden="true" />
                  {order.status === "open" ? "چاپ رسید" : "چاپ مجدد"}
                </button>
                {editable ? (
                  <button
                    type="button"
                    onClick={voidOrder}
                    disabled={busy}
                    className={`${DANGER_BUTTON} min-h-12`}
                  >
                    <Trash2Icon className="size-4" aria-hidden="true" />
                    ابطال سفارش
                  </button>
                ) : null}
              </div>
            ) : null}
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
            {!order ? (
              <div
                className="space-y-3"
                aria-busy="true"
                aria-label="در حال بارگذاری جزئیات سفارش"
              >
                <div className="ops-skeleton h-32 rounded-2xl" />
                <div className="ops-skeleton h-40 rounded-2xl" />
                <div className="ops-skeleton h-24 rounded-2xl" />
              </div>
            ) : (
              <>
                {error ? (
                  <div
                    className="mb-3 flex flex-col gap-2 rounded-xl border border-[#D95757]/20 bg-[#D95757]/[0.035] px-4 py-3 text-sm text-[#A23C3C] sm:flex-row sm:items-center sm:justify-between"
                    role="status"
                  >
                    <span>{error}</span>
                    <button
                      type="button"
                      onClick={() => setError("")}
                      className="min-h-11 shrink-0 rounded-lg border border-[#D95757]/25 bg-white px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D95757]/35"
                    >
                      باشد
                    </button>
                  </div>
                ) : null}
                {info ? (
                  <p
                    className="mb-3 rounded-xl border border-[#E9A11B]/25 bg-[#FFF9EE] px-4 py-3 text-sm leading-6 text-[#8A5B00]"
                    role="status"
                  >
                    {info}
                  </p>
                ) : null}
                {order.status === "voided" && order.voided_reason ? (
                  <p className="mb-3 rounded-xl border border-[#E5CCC5] bg-[#FFF7F4] px-4 py-3 text-sm text-[#9E4437]">
                    دلیل ابطال: {order.voided_reason}
                  </p>
                ) : null}

                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
                  <div className="min-w-0 space-y-3">
                    <section className={CARD} aria-label="اقلام سفارش">
                      <div className="flex items-center justify-between gap-3 border-b border-[#EAE8E2] px-4 py-3">
                        <h3 className="font-semibold text-[#252522]">
                          اقلام سفارش
                        </h3>
                        <span className="text-xs text-[#77756F]">
                          {toPersianDigits(itemCount)} قلم
                        </span>
                      </div>

                      {liveItems.length === 0 ? (
                        <p className="px-4 py-8 text-center text-sm text-[#77756F]">
                          قلم فعالی برای این سفارش ثبت نشده است.
                        </p>
                      ) : (
                        <>
                          <div
                            className={`hidden border-b border-[#EAE8E2] bg-[#FCFCFA] px-4 py-2.5 text-xs font-medium text-[#77756F] ${LINE_GRID}`}
                            aria-hidden="true"
                          >
                            <span>قلم</span>
                            <span>تعداد</span>
                            <span className="text-end">مبلغ</span>
                            <span />
                          </div>
                          <ul>{liveItems.map(renderLine)}</ul>
                        </>
                      )}

                      {voidedItems.length > 0 ? (
                        <div className="border-t border-[#EAE8E2]">
                          <button
                            type="button"
                            onClick={() => setShowVoided((value) => !value)}
                            aria-expanded={showVoided}
                            className={`flex min-h-12 w-full items-center justify-between gap-2 px-4 text-xs font-semibold text-[#77756F] transition-colors hover:bg-[#FCFCFA] ${FOCUS}`}
                          >
                            <span>
                              اقلام باطل‌شده (
                              {toPersianDigits(voidedItems.length)} مورد)
                            </span>
                            <span aria-hidden="true">
                              {showVoided ? "−" : "+"}
                            </span>
                          </button>
                          {showVoided ? (
                            <ul className="border-t border-[#EAE8E2] bg-[#FCFCFA]">
                              {voidedItems.map(renderLine)}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                    </section>

                    {editable ? (
                      <section
                        className={`${CARD} p-4`}
                        aria-label="افزودن قلم"
                      >
                        <h3 className="mb-3 font-semibold text-[#252522]">
                          افزودن قلم
                        </h3>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                          <div className="min-w-0 flex-1">
                            <SearchableSelect
                              value={addItemId}
                              onChange={setAddItemId}
                              ariaLabel="انتخاب آیتم برای افزودن"
                              className={OPS_INPUT}
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
                            className={`${OPS_INPUT} sm:w-20`}
                            dir="ltr"
                            inputMode="numeric"
                            aria-label="تعداد"
                            value={addQty}
                            onChange={(event) => setAddQty(event.target.value)}
                          />
                          <button
                            type="button"
                            onClick={startAddItem}
                            disabled={busy || !addItemId}
                            className={`${PRIMARY_BUTTON} sm:w-auto sm:min-w-28`}
                          >
                            <PlusIcon className="size-4" aria-hidden="true" />
                            افزودن
                          </button>
                        </div>
                        <p className="mt-2 text-xs leading-5 text-[#77756F]">
                          آیتم‌هایی که گروه افزودنی دارند، پیش از ثبت پنجرهٔ
                          انتخاب افزودنی را باز می‌کنند.
                        </p>
                      </section>
                    ) : null}

                    <section
                      className={`${CARD} p-4`}
                      aria-label="یادداشت سفارش"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-semibold text-[#252522]">
                          یادداشت سفارش
                        </h3>
                        {editable && !editingNote ? (
                          <button
                            type="button"
                            onClick={() => setEditingNote(true)}
                            className={SECONDARY_BUTTON}
                          >
                            <PencilIcon className="size-4" aria-hidden="true" />
                            {order.note ? "ویرایش" : "افزودن"}
                          </button>
                        ) : null}
                      </div>
                      {editingNote ? (
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                          <input
                            className={OPS_INPUT}
                            value={noteDraft}
                            onChange={(event) =>
                              setNoteDraft(event.target.value)
                            }
                            placeholder="مثلاً: مهمان عجله دارد"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={saveNote}
                              disabled={busy}
                              className={`${PRIMARY_BUTTON} sm:w-auto sm:min-w-24`}
                            >
                              ذخیره
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setNoteDraft(order.note ?? "");
                                setEditingNote(false);
                              }}
                              disabled={busy}
                              className={`${SECONDARY_BUTTON} min-h-12`}
                            >
                              انصراف
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm leading-6 text-[#77756F]">
                          {order.note || "یادداشتی ثبت نشده است."}
                        </p>
                      )}
                    </section>
                  </div>

                  <div className="min-w-0 space-y-3">
                    <section
                      className={`${CARD} p-4`}
                      aria-label="مشخصات سفارش"
                    >
                      <h3 className="mb-3 font-semibold text-[#252522]">
                        مشخصات سفارش
                      </h3>
                      {/* Flex rather than a 2-column grid: the number of facts
                          varies by order, and an odd one out should fill the
                          row instead of leaving a hole beside it. */}
                      <dl className="flex flex-wrap gap-2">
                        <Fact
                          label="نوع سفارش"
                          value={TYPE_LABELS[order.type]}
                        />
                        {order.table_name ? (
                          <Fact label="میز" value={order.table_name} />
                        ) : null}
                        {order.customer_name ? (
                          <Fact
                            label="مشتری"
                            value={
                              order.customer_phone
                                ? `${order.customer_name} · ${toPersianDigits(order.customer_phone)}`
                                : order.customer_name
                            }
                          />
                        ) : null}
                        {order.guest_count ? (
                          <Fact
                            label="تعداد مهمان"
                            value={toPersianDigits(order.guest_count)}
                          />
                        ) : null}
                        <Fact
                          label="زمان ثبت"
                          value={timeLabel(order.opened_at)}
                        />
                        {order.closed_at ? (
                          <Fact
                            label={
                              order.status === "voided"
                                ? "زمان ابطال"
                                : "زمان تسویه"
                            }
                            value={timeLabel(order.closed_at)}
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

                    <section className={`${CARD} p-4`} aria-label="مبلغ سفارش">
                      {editable ? (
                        <div className="mb-4 border-b border-[#EAE8E2] pb-4">
                          <h3 className="mb-2 font-semibold text-[#252522]">
                            تخفیف
                          </h3>
                          <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                              <div className="min-w-0 flex-1">
                                <SearchableSelect
                                  value={discountType}
                                  onChange={(value) =>
                                    setDiscountType(
                                      value as "" | "percent" | "amount",
                                    )
                                  }
                                  ariaLabel="نوع تخفیف"
                                  className={OPS_INPUT}
                                  options={[
                                    { value: "", label: "بدون تخفیف" },
                                    { value: "percent", label: "درصدی" },
                                    { value: "amount", label: "مبلغ ثابت" },
                                  ]}
                                />
                              </div>
                              {discountType ? (
                                <input
                                  className={`${OPS_INPUT} w-24`}
                                  dir="ltr"
                                  inputMode="numeric"
                                  aria-label="مقدار تخفیف"
                                  value={discountValue}
                                  onChange={(event) =>
                                    setDiscountValue(event.target.value)
                                  }
                                  placeholder={
                                    discountType === "percent" ? "٪" : "تومان"
                                  }
                                />
                              ) : null}
                            </div>
                            <button
                              type="button"
                              onClick={saveDiscount}
                              disabled={busy}
                              className={`${SECONDARY_BUTTON} min-h-12 w-full`}
                            >
                              اعمال تخفیف
                            </button>
                          </div>
                        </div>
                      ) : null}

                      <dl className="space-y-2">
                        <Row
                          label="جمع جزء"
                          value={formatToman(Number(order.subtotal))}
                        />
                        {addOnTotal !== 0 ? (
                          <Row
                            label="از این مبلغ، افزودنی‌ها"
                            value={formatModifierDelta(addOnTotal)}
                            accent
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
                        <div className="mt-1 flex items-center justify-between gap-3 rounded-xl border border-[#F2D097] bg-[#FFF9EE] px-3 py-2.5">
                          <dt className="text-sm font-bold text-[#252522]">
                            جمع کل
                          </dt>
                          <dd className="text-base font-bold tabular-nums text-[#B97905]">
                            {formatToman(Number(order.total))}
                          </dd>
                        </div>
                      </dl>
                    </section>

                    {editable ? (
                      <section
                        className={`${CARD} p-4`}
                        aria-label="دریافت وجه"
                      >
                        <h3 className="mb-3 font-semibold text-[#252522]">
                          دریافت وجه و تکمیل سفارش
                        </h3>
                        <div className="mb-3">
                          <PaymentWays
                            methods={paymentMethods}
                            draft={paymentDraft}
                            onChange={(draft) => {
                              setPaymentDraft(draft);
                              if (!draftNeedsCustomer(draft, paymentMethods)) {
                                setSelectedCustomer(null);
                                setCustomerQuery("");
                              }
                            }}
                            due={Number(order.total)}
                            disabled={paying}
                            idPrefix="order"
                          />
                        </div>

                        <label className="mb-3 block">
                          <span className="mb-1.5 block text-xs font-semibold text-[#5E5B55]">
                            انعام{" "}
                            <span className="font-normal text-[#8B8A85]">
                              (اختیاری، تومان)
                            </span>
                          </span>
                          <input
                            className={OPS_INPUT}
                            dir="ltr"
                            inputMode="numeric"
                            value={tipInput}
                            onChange={(event) =>
                              setTipInput(event.target.value)
                            }
                            placeholder="۰"
                          />
                        </label>

                        {needsCustomer ? (
                          <div className="mb-3 rounded-xl border border-[#EAE8E2] bg-[#FCFCFA] p-3">
                            {selectedCustomer ? (
                              <div className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-sm text-[#252522]">
                                  {selectedCustomer.name}
                                  {selectedCustomer.phone
                                    ? ` — ${toPersianDigits(selectedCustomer.phone)}`
                                    : ""}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setSelectedCustomer(null)}
                                  className={`${SECONDARY_BUTTON} shrink-0`}
                                >
                                  تغییر
                                </button>
                              </div>
                            ) : (
                              <>
                                <input
                                  className={`${OPS_INPUT} bg-white`}
                                  placeholder="جستجوی نام یا شماره تماس مشتری…"
                                  value={customerQuery}
                                  onChange={(event) =>
                                    setCustomerQuery(event.target.value)
                                  }
                                />
                                {customerResults.length > 0 ? (
                                  <ul className="mt-2 max-h-44 divide-y divide-[#F1EFEA] overflow-y-auto rounded-xl border border-[#EAE8E2] bg-white">
                                    {customerResults.map((customer) => (
                                      <li key={customer.id}>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setSelectedCustomer(customer)
                                          }
                                          className={`block min-h-12 w-full px-3 text-start text-sm text-[#252522] hover:bg-[#FCFCFA] ${FOCUS}`}
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
                                  <button
                                    type="button"
                                    onClick={() => setShowNewCustomer(true)}
                                    className={`mt-2 min-h-11 text-xs font-bold text-[#9B6700] hover:underline ${FOCUS}`}
                                  >
                                    + مشتری جدید «{customerQuery.trim()}»
                                  </button>
                                ) : null}
                                {showNewCustomer ? (
                                  <div className="mt-2 flex flex-col gap-2">
                                    <input
                                      className={`${OPS_INPUT} bg-white`}
                                      dir="ltr"
                                      placeholder="شماره تماس (اختیاری)"
                                      value={newCustomerPhone}
                                      onChange={(event) =>
                                        setNewCustomerPhone(event.target.value)
                                      }
                                    />
                                    <button
                                      type="button"
                                      onClick={createCustomer}
                                      disabled={!customerQuery.trim()}
                                      className={`${SECONDARY_BUTTON} min-h-12 w-full`}
                                    >
                                      ثبت مشتری
                                    </button>
                                  </div>
                                ) : null}
                              </>
                            )}
                          </div>
                        ) : null}

                        <button
                          type="button"
                          onClick={pay}
                          disabled={
                            paying ||
                            paymentMethods.length === 0 ||
                            (needsCustomer && !selectedCustomer)
                          }
                          className={PRIMARY_BUTTON}
                        >
                          <BanknoteIcon className="size-4" aria-hidden="true" />
                          {paying
                            ? "در حال ثبت پرداخت…"
                            : `دریافت ${formatToman(Number(order.total))} و تکمیل`}
                        </button>
                      </section>
                    ) : null}
                  </div>
                </div>

                {amendable && orderId ? (
                  <div className="mt-3">
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
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* Pinned, so scrolling a long bill never takes the amount being
              collected off-screen — the same reason the POS cart pins its own
              total. */}
          {order ? (
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[#EAE8E2] bg-white px-4 py-3 sm:px-5">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold text-[#252522]">جمع کل</span>
                <span className="text-xs text-[#77756F]">
                  {toPersianDigits(itemCount)} قلم
                </span>
              </div>
              <span className="text-base font-bold tabular-nums text-[#B97905]">
                {formatToman(Number(order.total))}
              </span>
            </div>
          ) : null}
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
          tone="amber"
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
    <div className="min-w-0 flex-1 basis-[calc(50%-0.25rem)] rounded-xl border border-[#F1EFEA] bg-[#FCFCFA] p-3">
      <dt className="text-[11px] text-[#77756F]">{label}</dt>
      <dd className="mt-1 truncate text-sm font-bold text-[#252522]">
        {value}
      </dd>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-[#77756F]">{label}</dt>
      <dd
        className={`tabular-nums ${accent ? "font-semibold text-[#B97905]" : "text-[#5E5B55]"}`}
      >
        {value}
      </dd>
    </div>
  );
}
