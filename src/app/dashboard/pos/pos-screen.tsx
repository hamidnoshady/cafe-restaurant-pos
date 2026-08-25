"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useDeferredValue,
} from "react";
import {
  CheckIcon,
  MinusIcon,
  PlusIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  SearchIcon,
  ShoppingBagIcon,
  SlidersHorizontalIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { toPersianDigits } from "@/lib/digits";
import type { KitchenTicketData } from "@/lib/kitchen-ticket-template";
import type { ReceiptData } from "@/lib/receipt-template";
import { useMoney } from "@/components/money/money-context";
import {
  draftOpensDrawer,
  draftReceiptPayments,
  emptyPaymentDraft,
  methodOf,
  paymentDraftBody,
  type PaymentDraft,
  type PaymentDraftBody,
} from "@/lib/payment-draft";
import { PaymentWays, usePaymentMethods } from "../payment-ways";
import {
  computeOrderTotals,
  formatQueueLabel,
  type CartLine,
  type DiscountInput,
} from "@/lib/orders";
import {
  kickDrawer,
  printKitchenTicket,
  printReceipt,
} from "@/lib/print-agent-client";
import {
  cartQuantitiesByItem,
  isGlobalCashierShortcutEligible,
  isTableOccupied,
  missingCheckoutRequirement,
  requiresTableSelection,
  searchPosMenuItems,
  type PosCheckoutRequirement,
  type PosTable,
} from "@/lib/pos-selection";
import {
  formatModifierDelta,
  linePriceBreakdown,
  modifierNamesLabel,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import { ModifierPicker } from "../modifier-picker";
import { TablePickerDialog } from "./table-picker-dialog";
import {
  SearchableSelect,
  type SelectOption,
} from "@/components/ui/searchable-select";
import { BranchSwitcher } from "../branch-switcher";
import { apiOrQueue, useOfflineQueue } from "../offline-queue";
import { api, ErrorBox, errorMessage, inputClass } from "../ui";
import { firstPrinter, useBusinessInfo, usePrinters } from "../use-printers";

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
interface Courier {
  id: string;
  name: string;
  phone: string | null;
}
interface Customer {
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
  /**
   * Name + price of every chosen add-on, kept together so any surface that
   * renders this line can show what was added *and* what it costs. The label
   * and the deltas the printer/total code needs are derived from this rather
   * than stored beside it, so they can't drift apart.
   */
  modifiers: DisplayModifier[];
  note: string;
}

type OrderType = "dine_in" | "takeaway" | "delivery";
type CheckoutIntent = "order" | "payment";

interface CheckoutResult {
  orderNumber: number | null;
  type: OrderType;
  tableName: string | null;
  total: number;
  queued: boolean;
  paid: boolean;
  paymentPending: boolean;
  paymentError?: string;
  /** Snapshot of what was sent, so the confirmation can restate the lines and their add-ons. */
  lines: CartUiLine[];
}

export function PosScreen({ initialTableId }: { initialTableId?: string | null }) {
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [tables, setTables] = useState<PosTable[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerQuery, setCustomerQuery] = useState("");
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [cart, setCart] = useState<CartUiLine[]>([]);
  const [orderType, setOrderType] = useState<OrderType>("dine_in");
  /**
   * `?table=<id>` seats this sale before a single item is rung — that is how
   * «مهمان جدید روی این میز» on an order's detail hands a friend at an already
   * busy table their own, separate bill.
   */
  const [tableId, setTableId] = useState(initialTableId ?? "");
  /**
   * Which checkout the table prompt is standing in front of, or null when it is
   * closed: `"select"` when the cashier opened it from the cart themselves,
   * `"order"`/`"payment"` when they pressed a close-the-sale button with no
   * table yet and confirming should carry straight on into it.
   */
  const [tablePickerFor, setTablePickerFor] = useState<
    CheckoutIntent | "select" | null
  >(null);
  const [guestCount, setGuestCount] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryPhone, setDeliveryPhone] = useState("");
  const [deliveryFee, setDeliveryFee] = useState("");
  const [deliveryCourierId, setDeliveryCourierId] = useState("");
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">(
    "",
  );
  const [discountValue, setDiscountValue] = useState("");
  const [pickerItem, setPickerItem] = useState<Item | null>(null);
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checkoutIntent, setCheckoutIntent] = useState<CheckoutIntent>("order");
  /**
   * The product tile that was last added to, flashed for a moment so a tap on a
   * grid of near-identical tiles is visibly acknowledged. Purely cosmetic: the
   * count badge on the tile is the durable feedback.
   */
  const [flashItemId, setFlashItemId] = useState<string | null>(null);
  // The ways this business takes money, in its own order — no longer three
  // hard-coded buttons. `paymentDraft` is what the cashier has chosen,
  // including a split across several of them (src/lib/payment-draft.ts).
  const { methods: paymentMethods } = usePaymentMethods();
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>(() =>
    emptyPaymentDraft([]),
  );
  // The ways arrive after the first render, so the draft starts pointing at
  // nothing; this settles it on the business's first way once they land (and
  // again if a way the draft was holding gets retired mid-shift).
  useEffect(() => {
    setPaymentDraft((draft) =>
      methodOf(paymentMethods, draft.methodId)
        ? draft
        : emptyPaymentDraft(paymentMethods),
    );
  }, [paymentMethods]);
  const [tipInput, setTipInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const printers = usePrinters();
  const business = useBusinessInfo();
  const money = useMoney();
  const { isOnline, pendingCount } = useOfflineQueue();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const submissionInFlight = useRef(false);

  const load = useCallback(() => {
    setIsRefreshing(true);
    Promise.all([
      api<MenuData>("/api/menu"),
      api<{ tables: PosTable[] }>("/api/tables"),
      api<{ couriers: Courier[] }>("/api/couriers"),
    ])
      .then(([menuRes, tablesRes, couriersRes]) => {
        if (menuRes.ok) {
          setMenu(menuRes.data);
          setActiveCategory(
            (current) =>
              current ||
              menuRes.data.categories.find((category) => category.is_active)
                ?.id ||
              "",
          );
        }
        if (tablesRes.ok) setTables(tablesRes.data.tables);
        if (couriersRes.ok) setCouriers(couriersRes.data.couriers);
        setLoadError(
          !menuRes.ok || !tablesRes.ok || !couriersRes.ok
            ? "بخشی از اطلاعات صندوق به‌روز نشد. داده‌های موجود حفظ شده‌اند."
            : "",
        );
      })
      .catch(() =>
        setLoadError("ارتباط با صندوق برقرار نشد. داده‌های موجود حفظ شده‌اند."),
      )
      .finally(() => {
        setInitialLoading(false);
        setIsRefreshing(false);
      });
  }, []);

  useEffect(load, [load]);

  /**
   * The customer picker searches server-side: the directory can be far longer
   * than the twenty rows /api/customers returns, so each keystroke in the
   * combobox refetches instead of filtering a truncated local list. The empty
   * query on mount is what fills the picker with the most recent customers.
   */
  useEffect(() => {
    const timer = setTimeout(
      () => {
        api<{ customers?: Customer[] }>(
          "/api/customers?q=" + encodeURIComponent(customerQuery.trim()),
        ).then(({ ok, data }) => {
          if (ok) setCustomers(data.customers ?? []);
        });
      },
      customerQuery.trim() ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [customerQuery]);

  const activeCategories = useMemo(
    () => menu?.categories.filter((category) => category.is_active) ?? [],
    [menu],
  );

  // ⚡ Bolt: Separate static data operations (filtering and map creation) into distinct useMemo
  // so they are not recalculated on every search query tick.
  const posItems = useMemo(
    () =>
      menu?.items.filter(
        (item): item is Item & { category_id: string } =>
          item.category_id !== null,
      ) ?? [],
    [menu],
  );

  const itemsById = useMemo(
    () => new Map(menu?.items.map((item) => [item.id, item]) ?? []),
    [menu],
  );

  const visibleProducts = useMemo(() => {
    if (!menu) return [];
    const searchResults = searchPosMenuItems({
      categories: menu.categories,
      items: posItems,
      selectedCategoryId: activeCategory,
      // ⚡ Bolt: Use deferredSearchQuery to prevent typing lag during expensive menu searches
      query: deferredSearchQuery,
    });
    return searchResults.flatMap((result) => {
      const item = itemsById.get(result.id);
      return item ? [{ item, categoryLabel: result.categoryLabel }] : [];
    });
  }, [activeCategory, menu, deferredSearchQuery, posItems, itemsById]);

  useEffect(() => {
    setSearchActiveIndex((index) =>
      Math.min(index, Math.max(visibleProducts.length - 1, 0)),
    );
  }, [visibleProducts.length]);

  useEffect(() => {
    const activeResult = visibleProducts[searchActiveIndex];
    document
      .getElementById(activeResult ? `pos-product-${activeResult.item.id}` : "")
      ?.scrollIntoView({ block: "nearest" });
  }, [searchActiveIndex, visibleProducts]);

  /**
   * `startCheckout` closes over the whole cart, so it is a plain function that
   * this render rebuilds; the global shortcut below reads it through a ref
   * rather than resubscribing its listener on every keystroke.
   */
  const startCheckoutRef = useRef<(intent: CheckoutIntent) => void>(() => {});

  // `result` counts as an overlay in its own right: an order opened in one tap
  // shows its confirmation without ever setting `reviewOpen`, and "/" must not
  // reach the product search behind it.
  const hasOpenOverlay = Boolean(
    pickerItem || reviewOpen || cartSheetOpen || result || tablePickerFor,
  );
  useEffect(() => {
    function handleGlobalShortcut(event: KeyboardEvent) {
      const eligible = isGlobalCashierShortcutEligible({
        activeElement: document.activeElement,
        hasOpenDialog: hasOpenOverlay,
      });
      if (!eligible) return;

      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        /^\d$/.test(event.key)
      ) {
        const category = activeCategories[Number(event.key) - 1];
        if (category) {
          event.preventDefault();
          setActiveCategory(category.id);
          setSearchQuery("");
          setSearchActiveIndex(0);
        }
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "Enter" &&
        cart.length > 0
      ) {
        event.preventDefault();
        startCheckoutRef.current(checkoutIntent);
      }
    }

    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [activeCategories, cart.length, checkoutIntent, hasOpenOverlay]);

  const attachedGroups = useCallback(
    (itemId: string): (ModifierGroup & { modifiers: Modifier[] })[] => {
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

  function categoryTaxRate(categoryId: string | null): number {
    return Number(
      menu?.categories.find((c) => c.id === categoryId)?.tax_rate ?? 0,
    );
  }

  function addToCart(
    item: Item,
    selectedModifierIds: string[],
    note: string,
    quantity = 1,
  ) {
    const units = Math.max(1, Math.round(quantity));
    const modifiers: DisplayModifier[] = selectedModifierIds.map((id) => {
      const modifier = menu!.modifiers.find((m) => m.id === id)!;
      return { name: modifier.name, priceDelta: Number(modifier.price_delta) };
    });
    const modifierIds = [...selectedModifierIds].sort();
    setCart((prev) => {
      const existing = prev.find(
        (l) =>
          l.menuItemId === item.id &&
          l.note === note &&
          l.modifierIds.length === modifierIds.length &&
          l.modifierIds.every((id, i) => id === modifierIds[i]),
      );
      if (existing) {
        return prev.map((l) =>
          l.key === existing.key ? { ...l, quantity: l.quantity + units } : l,
        );
      }
      const line: CartUiLine = {
        key: `${item.id}-${crypto.randomUUID()}`,
        menuItemId: item.id,
        name: item.name,
        unitPrice: Number(item.price),
        quantity: units,
        taxRatePercent: categoryTaxRate(item.category_id),
        modifierIds,
        modifiers,
        note,
      };
      return [...prev, line];
    });
    flashItem(item.id);
  }

  function flashItem(itemId: string) {
    setFlashItemId(itemId);
    window.setTimeout(
      () => setFlashItemId((current) => (current === itemId ? null : current)),
      450,
    );
  }

  /**
   * The − / + on a product tile, so a count can be corrected without opening the
   * cart at all — the step that used to mean "open the sheet, find the line,
   * press +" on a phone.
   *
   * It moves the *last* line for that product, which is the one the cashier just
   * touched. Earlier lines of the same product exist only when they carry
   * different add-ons or a different note, and those stay where they are: the
   * tile deliberately cannot rewrite a customised line it does not show.
   */
  function stepItemQuantity(itemId: string, delta: 1 | -1) {
    setCart((prev) => {
      for (let index = prev.length - 1; index >= 0; index -= 1) {
        if (prev[index].menuItemId !== itemId) continue;
        const line = prev[index];
        const next = line.quantity + delta;
        if (next <= 0) return prev.filter((l) => l.key !== line.key);
        return prev.map((l) =>
          l.key === line.key ? { ...l, quantity: next } : l,
        );
      }
      return prev;
    });
    if (delta === 1) flashItem(itemId);
  }

  /**
   * Switching the order type drops what no longer applies, so a table chosen for
   * a dine-in sale cannot ride along on a takeaway. The guest count goes with it:
   * the two are only ever asked for together.
   */
  function changeOrderType(next: OrderType) {
    setOrderType(next);
    if (next !== "dine_in") {
      setTableId("");
      setGuestCount("");
    }
  }

  /** Tapping a tile: straight into the cart, or into the picker when the item has add-ons to answer for. */
  function pickItem(item: Item) {
    const groups = attachedGroups(item.id);
    if (groups.length === 0) {
      addToCart(item, [], "");
    } else {
      setPickerItem(item);
    }
  }

  function setQty(key: string, quantity: number) {
    setCart((prev) =>
      quantity <= 0
        ? prev.filter((l) => l.key !== key)
        : prev.map((l) => (l.key === key ? { ...l, quantity } : l)),
    );
  }
  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
  }

  // ⚡ Bolt: Memoize cart computations to prevent jank on frequent state changes (e.g., search typing)
  // The discount amount is entered in the business's display unit (like every
  // other money input in this screen) but `computeOrderTotals` works in Rial,
  // so convert it here — the same boundary `feeNum`/`tipNum` below use. Percent
  // stays a percent.
  const discount: DiscountInput = useMemo(
    () =>
      discountType
        ? {
            type: discountType,
            value:
              discountType === "amount"
                ? money.fromInput(Math.max(0, Math.round(Number(discountValue) || 0)))
                : Number(discountValue) || 0,
          }
        : { type: null },
    [discountType, discountValue],
  );
  const cartLines: CartLine[] = useMemo(
    () =>
      cart.map((l) => ({
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        modifierDeltas: l.modifiers.map((modifier) => modifier.priceDelta),
        taxRatePercent: l.taxRatePercent,
      })),
    [cart],
  );
  const cartItemCount = useMemo(
    () => cart.reduce((count, line) => count + line.quantity, 0),
    [cart],
  );
  /** How many of each product the cart holds, for the count badge on its tile. */
  const cartCountsByItem = useMemo(() => cartQuantitiesByItem(cart), [cart]);
  /**
   * What is still missing, named before the cashier commits to anything. The two
   * close-the-sale buttons label themselves with it instead of sitting enabled
   * and failing three screens later.
   */
  const blocker = useMemo<PosCheckoutRequirement | null>(
    () =>
      missingCheckoutRequirement({
        orderType,
        tableId,
        deliveryAddress,
        lineCount: cart.length,
      }),
    [cart.length, deliveryAddress, orderType, tableId],
  );
  /** The chosen table, once it is one this branch still has. */
  const selectedTable = useMemo(
    () => tables.find((table) => table.id === tableId) ?? null,
    [tableId, tables],
  );
  /**
   * A table arriving by `?table=` may not be in the list yet (it is still
   * loading) or at all — the sale is still seated, so say so rather than
   * claiming no table was chosen.
   */
  const tableLabel =
    selectedTable?.name ?? (tableId ? "میز انتخاب‌شده" : "میزی انتخاب نشده");
  const cartAddOnTotal = useMemo(
    () =>
      cart.reduce(
        (sum, line) =>
          sum +
          line.modifiers.reduce(
            (lineSum, modifier) => lineSum + modifier.priceDelta,
            0,
          ) *
            line.quantity,
        0,
      ),
    [cart],
  );
  // Fee/tip are entered in Toman (like menu prices) but stored/sent in Rial.
  const feeNum =
    orderType === "delivery"
      ? money.fromInput(Math.max(0, Math.round(Number(deliveryFee) || 0)))
      : 0;
  const tipNum = money.fromInput(Math.max(0, Math.round(Number(tipInput) || 0)));
  const totals = useMemo(
    () => computeOrderTotals(cartLines, discount, feeNum),
    [cartLines, discount, feeNum],
  );
  /**
   * A chosen customer stays in the list even once a later search stops
   * returning them — otherwise the trigger would fall back to its placeholder
   * while the order still carries the selection.
   */
  const customerOptions = useMemo(() => {
    const known =
      customer && !customers.some((row) => row.id === customer.id)
        ? [customer, ...customers]
        : customers;
    return [
      { value: "", label: "بدون مشتری" },
      ...known.map((row) => ({
        value: row.id,
        label: row.phone
          ? row.name + " — " + toPersianDigits(row.phone)
          : row.name,
        searchString: row.name + " " + (row.phone ?? ""),
      })),
    ];
  }, [customer, customers]);

  function selectCustomer(value: string) {
    setCustomer(
      value
        ? (customers.find((row) => row.id === value) ??
            (customer?.id === value ? customer : null))
        : null,
    );
  }

  /**
   * `overrides` is how the table prompt places an order with the table that was
   * just chosen in it: confirming the prompt sets the state *and* submits in the
   * same tick, and the state this closure captured is still the old one.
   */
  async function submit(
    intent: CheckoutIntent = "order",
    overrides?: { tableId?: string; guestCount?: string },
  ): Promise<boolean> {
    if (busy || submissionInFlight.current) return false;
    setError("");
    const effectiveTableId = overrides?.tableId ?? tableId;
    const effectiveGuestCount = overrides?.guestCount ?? guestCount;
    if (cart.length === 0) {
      setError("سبد خرید خالی است.");
      return false;
    }
    if (requiresTableSelection({ orderType, tableId: effectiveTableId })) {
      setError("برای سفارش حضوری، میز را انتخاب کنید.");
      return false;
    }
    if (orderType === "delivery" && !deliveryAddress.trim()) {
      setError("برای سفارش ارسالی آدرس الزامی است.");
      return false;
    }

    // How the money is being taken is settled *before* the order is created:
    // a split that doesn't add up would otherwise leave an open order behind
    // and a cashier wondering which of the two things failed.
    let paymentBody: PaymentDraftBody[] = [];
    if (intent === "payment") {
      const built = paymentDraftBody(
        paymentDraft,
        paymentMethods,
        totals.total,
        money.unit,
      );
      if (!built.ok) {
        setError(errorMessage(built.error));
        return false;
      }
      if (
        built.value.some(
          (tender) =>
            methodOf(paymentMethods, tender.methodId)?.settlement === "credit",
        ) &&
        !customer
      ) {
        setError(errorMessage("customer_required"));
        return false;
      }
      paymentBody = built.value;
    }

    submissionInFlight.current = true;
    setBusy(true);
    const orderBody = {
      type: orderType,
      tableId: orderType === "dine_in" ? effectiveTableId : undefined,
      customerId: customer?.id ?? undefined,
      guestCount: effectiveGuestCount ? Number(effectiveGuestCount) : undefined,
      discount: discountType
        ? {
            type: discountType,
            value:
              discountType === "amount"
                ? money.fromInput(Math.max(0, Math.round(Number(discountValue) || 0)))
                : Number(discountValue) || 0,
          }
        : undefined,
      items: cart.map((line) => ({
        menuItemId: line.menuItemId,
        quantity: line.quantity,
        modifierIds: line.modifierIds,
        note: line.note || undefined,
      })),
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
    const typeLabel =
      orderType === "dine_in"
        ? "حضوری"
        : orderType === "takeaway"
          ? "بیرون‌بر"
          : "ارسالی";
    const tableName =
      orderType === "dine_in"
        ? (tables.find((table) => table.id === effectiveTableId)?.name ?? null)
        : null;

    let creation: {
      ok: boolean;
      queued: boolean;
      data: { error?: string; orderNumber?: number; id?: string };
    };
    try {
      creation = await apiOrQueue<{
        error?: string;
        orderNumber?: number;
        id?: string;
      }>(
        "/api/orders",
        { method: "POST", body: orderBody },
        {
          type: "order.create",
          payload: orderBody,
          description: "سفارش " + typeLabel,
        },
      );
    } catch {
      setBusy(false);
      submissionInFlight.current = false;
      setError("ثبت سفارش ممکن نشد. دوباره تلاش کنید.");
      return false;
    }

    if (!creation.ok) {
      setBusy(false);
      submissionInFlight.current = false;
      setError(errorMessage(creation.data.error));
      return false;
    }

    const orderNumber = creation.queued
      ? null
      : creation.data.orderNumber || null;
    let paid = false;
    let paymentPending = false;
    let paymentError: string | undefined;

    if (intent === "payment") {
      if (creation.queued || !creation.data.id) {
        paymentPending = true;
        paymentError =
          "سفارش در صف همگام‌سازی است؛ دریافت وجه را پس از اتصال از بخش سفارش‌ها تکمیل کنید.";
      } else {
        try {
          const payment = await api<{ error?: string }>(
            "/api/orders/" + creation.data.id + "/pay",
            {
              method: "POST",
              body: JSON.stringify({
                payments: paymentBody,
                customerId: customer?.id ?? undefined,
                tipAmount: tipNum,
              }),
            },
          );
          if (payment.ok) {
            paid = true;
          } else {
            paymentPending = true;
            paymentError = errorMessage(payment.data.error);
          }
        } catch {
          paymentPending = true;
          paymentError =
            "سفارش ثبت شد، اما ارتباط هنگام دریافت وجه قطع شد. وضعیت سفارش را از بخش سفارش‌ها بررسی کنید.";
        }
      }
    }

    const kitchenPrinter = firstPrinter(printers, "kitchen");
    if (!creation.queued && kitchenPrinter) {
      // The big line on a kitchen ticket is the table when there is one — that
      // is what the runner carries the tray to.
      const label = tableName ?? typeLabel;
      const ticket: KitchenTicketData = {
        label,
        orderTypeLabel: typeLabel,
        sentAt: new Date().toISOString(),
        lines: cart.map((line) => ({
          name: line.name,
          quantity: line.quantity,
          modifiersLabel: modifierNamesLabel(line.modifiers) || null,
          note: line.note || null,
        })),
      };
      void printKitchenTicket(kitchenPrinter.connection, ticket);
    }

    if (paid) {
      const receiptPrinter = firstPrinter(printers, "receipt");
      if (receiptPrinter) {
        const receipt: ReceiptData = {
          business: {
            name: business.name,
            address: business.address,
            phone: business.phone,
          },
          orderLabel: orderNumber
            ? formatQueueLabel(orderType, orderNumber)
            : typeLabel,
          orderTypeLabel:
            orderType === "dine_in"
              ? "حضوری" + (tableName ? " — " + tableName : "")
              : typeLabel,
          issuedAt: new Date().toISOString(),
          lines: cart.map((line) => ({
            name: line.name,
            quantity: line.quantity,
            lineTotal: linePriceBreakdown({
              unitPrice: line.unitPrice,
              modifierDeltas: line.modifiers.map(
                (modifier) => modifier.priceDelta,
              ),
              quantity: line.quantity,
            }).total,
            modifiersLabel: modifierNamesLabel(line.modifiers) || null,
          })),
          subtotal: totals.subtotal,
          discount: totals.discount,
          tax: totals.tax,
          total: totals.total,
          tip: tipNum,
          payments: draftReceiptPayments(
            paymentDraft,
            paymentMethods,
            totals.total,
            money.unit,
          ),
        };
        void printReceipt(receiptPrinter.connection, receipt);
        // Any cash in the split opens the drawer — a bill half paid in notes
        // still needs somewhere to put them.
        if (draftOpensDrawer(paymentDraft, paymentMethods))
          void kickDrawer(receiptPrinter.connection);
      }
    }

    setResult({
      orderNumber,
      type: orderType,
      tableName,
      total: totals.total,
      queued: creation.queued,
      paid,
      paymentPending,
      paymentError,
      lines: cart,
    });
    setCart([]);
    setTableId("");
    setGuestCount("");
    setCustomer(null);
    setCustomerQuery("");
    setDiscountType("");
    setDiscountValue("");
    setDeliveryAddress("");
    setDeliveryPhone("");
    setDeliveryFee("");
    setDeliveryCourierId("");
    setCheckoutIntent("order");
    setPaymentDraft(emptyPaymentDraft(paymentMethods));
    setTipInput("");
    setCartSheetOpen(false);
    setBusy(false);
    submissionInFlight.current = false;
    load();
    return true;
  }

  /**
   * The one way into the checkout, whichever button (or shortcut) starts it.
   *
   * Two things happen here rather than at the last press. An in-person sale with
   * no table yet is asked for one and carries on afterwards instead of being
   * rejected. And opening a tab goes straight through: «ثبت سفارش باز» creates an
   * order that is fully editable, re-priced and voidable from the orders screen,
   * so a confirmation in front of it only asked the cashier to approve something
   * they can undo — while «دریافت وجه» keeps its review, because that is the press
   * that moves money. Either way the confirmation *after* the fact still shows
   * what was created.
   */
  function startCheckout(intent: CheckoutIntent) {
    setError("");
    setCheckoutIntent(intent);
    if (requiresTableSelection({ orderType, tableId })) {
      setTablePickerFor(intent);
      return;
    }
    if (intent === "order") {
      void submit("order");
      return;
    }
    setReviewOpen(true);
  }
  startCheckoutRef.current = startCheckout;

  if (!menu)
    return (
      <PosLoadingState
        loading={initialLoading}
        error={loadError}
        onRetry={load}
      />
    );

  /**
   * Dismissing the confirmation is what ends one sale and starts the next: the
   * cart and every order-level field were already reset by submit(), so closing
   * the dialog just drops the receipt and hands the cashier an empty POS.
   */
  function closeCheckout() {
    setResult(null);
    setReviewOpen(false);
    setError("");
  }

  return (
    <div className="flex flex-col gap-3 md:h-[calc(100dvh-2rem)] md:flex-row">
      {/*
        Below `md` this panel is *not* a scroller. It was: `flex-1` +
        `overflow-hidden` around a grid that scrolled inside it, which on a
        phone left the grid a couple of rows tall — past the fourth product the
        tiles were clipped behind the cart bar, and the panel had swallowed the
        page's scroll so there was no way to reach them. On a phone the grid
        simply runs down the page and the page scrolls, the way every other
        screen does; from `md` up the two-column till is unchanged.
      */}
      <div className="flex flex-col overflow-hidden rounded-2xl border border-[#EAE8E2] bg-white shadow-[0_1px_3px_rgba(37,37,34,0.03)] md:min-h-0 md:flex-1">
        <div className="border-b border-[#EAE8E2] p-3 md:p-4">
          <div className="mb-3 hidden flex-wrap items-center gap-2 md:flex">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#FFF1D8] text-[#9B6700]">
                <ShoppingBagIcon className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold text-[#252522]">
                  صندوق فروش
                </h1>
                <p className="truncate text-xs text-[#77756F]">
                  عملیات فروش جاری
                </p>
              </div>
            </div>
            <BranchSwitcher compact />
            <span
              className={
                "inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold " +
                (isOnline
                  ? "bg-[#EAF8EF] text-[#258A4C]"
                  : "bg-[#FFF1D8] text-[#9B6700]")
              }
              role="status"
              aria-live="polite"
            >
              {isOnline ? (
                <WifiIcon className="size-4" aria-hidden="true" />
              ) : (
                <WifiOffIcon className="size-4" aria-hidden="true" />
              )}
              {isOnline
                ? pendingCount > 0
                  ? toPersianDigits(pendingCount) + " عملیات در صف"
                  : "همگام"
                : "آفلاین"}
            </span>
            <button
              type="button"
              onClick={load}
              disabled={isRefreshing}
              className="flex size-11 items-center justify-center rounded-xl border border-[#EAE8E2] bg-white text-[#77756F] transition duration-200 hover:bg-[#FCFCFA] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 disabled:opacity-60 motion-reduce:transition-none"
              aria-label={
                isRefreshing ? "در حال به‌روزرسانی صندوق" : "به‌روزرسانی صندوق"
              }
            >
              <RefreshCwIcon className="size-4" aria-hidden="true" />
            </button>
          </div>
          {loadError ? (
            <div
              className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-[#E9A11B]/25 bg-[#FFF9EE] px-3 py-2 text-xs text-[#5E5B55]"
              role="status"
            >
              <span>{loadError}</span>
              <button
                type="button"
                onClick={load}
                className="min-h-11 px-2 font-bold text-[#9B6700] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
              >
                تلاش دوباره
              </button>
            </div>
          ) : null}
          <label className="sr-only" htmlFor="pos-product-search">
            جستجوی محصول یا کد کالا
          </label>
          <div className="relative">
            <SearchIcon
              className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-[#77756F]"
              aria-hidden="true"
            />
            <input
              ref={searchInputRef}
              id="pos-product-search"
              className={
                inputClass +
                " min-h-12 border-[#EAE8E2] bg-[#FCFCFA] ps-10 shadow-none focus-visible:border-[#E9A11B] focus-visible:ring-[#E9A11B]/25"
              }
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setSearchActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (
                  visibleProducts.length === 0 ||
                  event.nativeEvent.isComposing
                )
                  return;
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const offset = event.key === "ArrowDown" ? 1 : -1;
                  setSearchActiveIndex(
                    (index) =>
                      (index + offset + visibleProducts.length) %
                      visibleProducts.length,
                  );
                }
                if (event.key === "Enter") {
                  event.preventDefault();

                  // ⚡ Bolt: Handle fast-input race conditions (like barcode scanners)
                  // If the user hit enter before the deferred query caught up, we must compute
                  // the results synchronously on the immediate query so we don't drop the scan.
                  let currentResults = visibleProducts;
                  if (searchQuery !== deferredSearchQuery) {
                    const immediateSearchResults = searchPosMenuItems({
                      categories: menu?.categories ?? [],
                      // ⚡ Bolt: Re-use precomputed items array
                      items: posItems,
                      selectedCategoryId: activeCategory,
                      query: searchQuery,
                    });

                    currentResults = immediateSearchResults.flatMap(
                      (result) => {
                        // ⚡ Bolt: Re-use precomputed items map
                        const item = itemsById.get(result.id);
                        return item
                          ? [{ item, categoryLabel: result.categoryLabel }]
                          : [];
                      },
                    );
                  }

                  const selected = currentResults[searchActiveIndex];
                  if (selected) pickItem(selected.item);
                }
              }}
              placeholder="جستجوی محصول (/)"
              role="combobox"
              aria-expanded={visibleProducts.length > 0}
              aria-controls="pos-product-results"
              aria-activedescendant={
                visibleProducts[searchActiveIndex]
                  ? `pos-product-${visibleProducts[searchActiveIndex].item.id}`
                  : undefined
              }
            />
          </div>
          <div
            className="mt-3 flex min-h-14 gap-2 overflow-x-auto pb-1"
            aria-label="دسته‌های فعال"
          >
            {activeCategories.map((category, index) => (
              <button
                key={category.id}
                type="button"
                onClick={() => {
                  setActiveCategory(category.id);
                  setSearchQuery("");
                  setSearchActiveIndex(0);
                }}
                className={`min-h-14 shrink-0 rounded-xl border px-4 text-sm font-bold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] motion-reduce:transition-none ${
                  activeCategory === category.id
                    ? "border-[#F2D097] bg-[#FFF1D8] text-[#9B6700] shadow-none"
                    : "border-[#EAE8E2] bg-white text-[#5E5B55] hover:border-[#F2D097] hover:bg-[#FCFCFA]"
                }`}
                aria-keyshortcuts={index < 9 ? `Alt+${index + 1}` : undefined}
              >
                {category.name}
              </button>
            ))}
          </div>
        </div>
        <div
          id="pos-product-results"
          role="listbox"
          /*
            Sized by the space the tiles actually get, not by the viewport. Fixed
            per-breakpoint column counts kept being wrong here because two other
            things eat the width first — the sidebar from `md` up and the 23–25rem
            cart panel beside it — so a 1024px laptop had ~370px for what the
            breakpoint thought was a four-column grid, and every tile truncated
            its category and its price. `auto-fill` with a 10rem floor asks the
            container instead: two columns on a phone, two beside the panel on a
            laptop, five on a wide till, with no breakpoint to keep in sync.
          */
          className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] content-start gap-2.5 p-3 md:flex-1 md:overflow-y-auto md:p-4"
        >
          {visibleProducts.map(({ item, categoryLabel }, index) => {
            const inCart = cartCountsByItem.get(item.id) ?? 0;
            const active = index === searchActiveIndex;
            return (
              /*
                A tile is three controls in one frame, so it can no longer be a
                single <button>: tapping it adds one, «تنظیم» opens the picker for
                add-ons, a note and a count, and once the product is in the cart a
                − / + strip corrects that count in place. That strip is the step
                the walkthrough was missing — the quantity used to be reachable
                only from the cart, which on a phone meant opening the sheet.
              */
              <div
                key={item.id}
                role="presentation"
                className={
                  "group relative flex touch-manipulation flex-col overflow-hidden rounded-2xl border transition duration-200 motion-reduce:transition-none " +
                  (active
                    ? "border-[#E9A11B] bg-[#FFF9EE] ring-1 ring-[#E9A11B]/25"
                    : inCart > 0
                      ? "border-[#F2D097] bg-[#FFFCF5]"
                      : "border-[#EAE8E2] bg-white hover:border-[#F2D097] hover:bg-[#FCFCFA]") +
                  (flashItemId === item.id
                    ? " ring-2 ring-[#E9A11B] ring-offset-1"
                    : "")
                }
              >
                <button
                  id={"pos-product-" + item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => pickItem(item)}
                  className="flex min-h-28 flex-1 flex-col items-stretch justify-between p-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E9A11B]/45 active:scale-[0.99] md:min-h-32 lg:min-h-36"
                  aria-label={
                    "افزودن " +
                    item.name +
                    " به سفارش" +
                    (inCart > 0
                      ? "؛ " + toPersianDigits(inCart) + " عدد در سبد"
                      : "")
                  }
                >
                  {/*
                    Name, category and price each own a full row. They used to
                    share it with a 40px badge, which at the widths a tile
                    actually gets beside the cart panel meant «نوشیدنی گ…» and a
                    wrapped price on every card. The count lives in the strip
                    below instead, where it is also adjustable.
                  */}
                  <span className="line-clamp-2 pe-8 text-sm font-bold leading-6 text-[#252522]">
                    {item.name}
                  </span>
                  <div className="mt-3">
                    <span className="block truncate text-xs text-[#77756F]">
                      {categoryLabel}
                    </span>
                    <span className="mt-1 block text-base font-bold text-[#B97905]">
                      {money.format(Number(item.price))}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setPickerItem(item)}
                  className="absolute end-2 top-2 flex size-9 items-center justify-center rounded-lg text-[#9B6700] transition-colors hover:bg-[#FFF1D8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
                  aria-label={"تعداد، افزودنی و یادداشت برای " + item.name}
                  title="تعداد، افزودنی و یادداشت"
                >
                  <SlidersHorizontalIcon className="size-4" aria-hidden="true" />
                </button>
                {inCart > 0 ? (
                  <div className="flex items-center justify-between gap-1 border-t border-[#F2D097] bg-white/70 px-1.5 py-1">
                    <button
                      type="button"
                      onClick={() => stepItemQuantity(item.id, -1)}
                      className="flex size-11 items-center justify-center rounded-lg text-[#5E5B55] transition-colors hover:bg-[#FFF1D8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
                      aria-label={"کاهش تعداد " + item.name}
                    >
                      <MinusIcon className="size-4" aria-hidden="true" />
                    </button>
                    <span className="text-sm font-bold text-[#252522]">
                      {toPersianDigits(inCart)}
                    </span>
                    <button
                      type="button"
                      onClick={() => stepItemQuantity(item.id, 1)}
                      className="flex size-11 items-center justify-center rounded-lg text-[#9B6700] transition-colors hover:bg-[#FFF1D8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
                      aria-label={"افزایش تعداد " + item.name}
                    >
                      <PlusIcon className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {visibleProducts.length === 0 ? (
            <div className="col-span-full flex min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-[#EAE8E2] bg-[#FCFCFA] p-4 text-center">
              <SearchIcon
                className="size-6 text-[#B9B6AE]"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-bold text-[#5E5B55]">
                آیتمی پیدا نشد
              </p>
              <p className="mt-1 text-xs text-[#77756F]">
                عبارت جستجو یا دسته‌بندی را تغییر دهید.
              </p>
            </div>
          ) : null}
        </div>
      </div>
      {/* Cart */}
      {/*
        Same squeeze as the mobile sheet, milder: on a short laptop the intake
        header and the payment block can leave the line list a few pixels of
        scroll. `min-h-40` on the list is its floor, and the column itself
        scrolls once the three sections together outgrow the viewport.
      */}
      <div className="hidden max-h-[46dvh] w-full shrink-0 flex-col overflow-y-auto rounded-2xl border border-[#EAE8E2] bg-white shadow-[0_1px_3px_rgba(37,37,34,0.03)] md:flex md:max-h-none md:w-[23rem] xl:w-[25rem]">
        <div className="shrink-0 border-b border-[#EAE8E2] p-4">
          <ErrorBox>{error}</ErrorBox>
          <OrderTypeTabs value={orderType} onChange={changeOrderType} />
          {orderType === "dine_in" ? (
            <>
              <TableField
                label={tableLabel}
                chosen={tableId !== ""}
                occupied={isTableOccupied(selectedTable?.status)}
                onPick={() => setTablePickerFor("select")}
              />
              <label className="mt-3 block text-xs font-semibold text-[#5E5B55]" htmlFor="pos-guest-count">
                تعداد مهمان
                <input
                  id="pos-guest-count"
                  className={inputClass + " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"}
                  dir="ltr"
                  inputMode="numeric"
                  value={guestCount}
                  onChange={(event) => setGuestCount(event.target.value)}
                  placeholder="اختیاری"
                />
              </label>
            </>
          ) : null}
          {orderType === "delivery" ? (
            <div className="space-y-3">
              <label
                className="block text-xs font-semibold text-[#5E5B55]"
                htmlFor="pos-delivery-address"
              >
                آدرس تحویل
                <textarea
                  id="pos-delivery-address"
                  className={
                    inputClass +
                    " mt-1 h-auto min-h-20 border-[#EAE8E2] bg-[#FCFCFA] py-2 focus-visible:border-[#E9A11B] focus-visible:ring-[#E9A11B]/25"
                  }
                  rows={2}
                  value={deliveryAddress}
                  onChange={(event) => setDeliveryAddress(event.target.value)}
                  placeholder="آدرس کامل تحویل"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label
                  className="block text-xs font-semibold text-[#5E5B55]"
                  htmlFor="pos-delivery-phone"
                >
                  تلفن مشتری
                  <input
                    id="pos-delivery-phone"
                    className={
                      inputClass +
                      " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"
                    }
                    dir="ltr"
                    inputMode="tel"
                    value={deliveryPhone}
                    onChange={(event) => setDeliveryPhone(event.target.value)}
                    placeholder="اختیاری"
                  />
                </label>
                <label
                  className="block text-xs font-semibold text-[#5E5B55]"
                  htmlFor="pos-delivery-fee"
                >
                  هزینهٔ ارسال
                  <input
                    id="pos-delivery-fee"
                    className={
                      inputClass +
                      " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"
                    }
                    dir="ltr"
                    inputMode="numeric"
                    value={deliveryFee}
                    onChange={(event) => setDeliveryFee(event.target.value)}
                    placeholder={money.unitLabel}
                  />
                </label>
              </div>
              <label className="block text-xs font-semibold text-[#5E5B55]">
                پیک
                <SearchableSelect
                  className={
                    inputClass + " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"
                  }
                  value={deliveryCourierId}
                  onChange={setDeliveryCourierId}
                  ariaLabel="پیک ارسال"
                  options={[
                    { value: "", label: "تخصیص پیک بعداً (در صف ارسال)" },
                    ...couriers.map((courier) => ({
                      value: courier.id,
                      label: courier.name,
                    })),
                  ]}
                />
              </label>
            </div>
          ) : null}
          <CustomerField
            value={customer?.id ?? ""}
            options={customerOptions}
            onChange={selectCustomer}
            onQueryChange={setCustomerQuery}
          />
        </div>

        {/*
          The lines grow; the column around them scrolls. This used to be a
          `flex-1` scroll box with a 10rem floor, which on a laptop meant the
          cart — the one part of the panel that changes with every tap — was the
          smallest region on screen: a two-line order showed one line, with the
          second hidden in a scroll box nothing pointed at, while the payment
          block below kept its 300px. `shrink-0` is what makes it grow instead of
          being squeezed into the leftovers. The footer is sticky, so a long cart
          never pushes the pay button out of reach.
        */}
        <div className="shrink-0 p-4">
          {cart.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#EAE8E2] bg-[#FCFCFA] p-4 text-center text-sm text-[#77756F]">
              سبد خالی است. از فهرست محصولات، آیتم‌ها را اضافه کنید.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {cart.map((l) => {
                const line = linePriceBreakdown({
                  unitPrice: l.unitPrice,
                  modifierDeltas: l.modifiers.map(
                    (modifier) => modifier.priceDelta,
                  ),
                  quantity: l.quantity,
                });
                return (
                  <li
                    key={l.key}
                    className={
                      "rounded-xl border p-3 text-sm animate-in fade-in slide-in-from-top-1 duration-150 " +
                      (l.modifiers.length > 0
                        ? "border-[#F2D097] bg-[#FFFCF5]"
                        : "border-[#EAE8E2] bg-white")
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-bold text-[#252522]">{l.name}</p>
                        <p className="mt-0.5 text-xs text-[#77756F]">
                          {l.modifiers.length > 0 ? (
                            <>
                              {money.format(l.unitPrice, { withUnit: false })}
                              {" + "}
                              <span className="font-bold text-[#B97905]">
                                {formatModifierDelta(line.addOns, {
                                  withUnit: false,
                                  unit: money.unit,
                                })}
                              </span>
                              {" = "}
                              <span className="font-bold text-[#252522]">
                                {money.format(line.unit)}
                              </span>{" "}
                              هر واحد
                            </>
                          ) : (
                            money.format(l.unitPrice) + " هر واحد"
                          )}
                        </p>
                      </div>
                      <p className="shrink-0 font-bold text-[#B97905]">
                        {money.format(line.total)}
                      </p>
                    </div>
                    <ModifierBadges
                      modifiers={l.modifiers}
                      tone="amber"
                      showCaption={false}
                      className="mt-2"
                    />
                    {l.note ? (
                      <p className="mt-2 text-xs text-[#77756F]">
                        یادداشت: {l.note}
                      </p>
                    ) : null}
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        aria-label={"کاهش تعداد " + l.name}
                        onClick={() => setQty(l.key, l.quantity - 1)}
                        className="flex size-12 items-center justify-center rounded-lg bg-muted text-lg text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground active:scale-95"
                      >
                        −
                      </button>
                      <span className="w-8 text-center text-base font-semibold">
                        {toPersianDigits(l.quantity)}
                      </span>
                      <button
                        type="button"
                        aria-label={"افزایش تعداد " + l.name}
                        onClick={() => setQty(l.key, l.quantity + 1)}
                        className="flex size-12 items-center justify-center rounded-lg bg-muted text-lg text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground active:scale-95"
                      >
                        +
                      </button>
                      <button
                        type="button"
                        aria-label={"حذف " + l.name}
                        onClick={() => removeLine(l.key)}
                        className="ms-auto px-2 py-1 text-sm text-destructive hover:underline"
                      >
                        حذف
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Sticky, so the column scrolling never takes the pay button
            off-screen the way a plain flow footer would. */}
        <div className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-white p-4">
          <div className="mb-3 flex gap-2">
            <SearchableSelect
              value={discountType}
              onChange={(value) =>
                setDiscountType(value as "" | "percent" | "amount")
              }
              ariaLabel="نوع تخفیف"
              options={[
                { value: "", label: "بدون تخفیف" },
                { value: "percent", label: "درصدی" },
                { value: "amount", label: "مبلغ ثابت" },
              ]}
            />
            {discountType ? (
              <input
                className={inputClass}
                aria-label="مقدار تخفیف"
                dir="ltr"
                inputMode="numeric"
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder={discountType === "percent" ? "درصد" : money.unit === "rial" ? "ریال" : "تومان"}
              />
            ) : null}
          </div>

          <dl className="mb-3 space-y-1 text-sm">
            <Row label="جمع جزء" value={money.format(totals.subtotal)} />
            {cartAddOnTotal !== 0 ? (
              <Row
                label="از این مبلغ، افزودنی‌ها"
                value={formatModifierDelta(cartAddOnTotal, { unit: money.unit })}
              />
            ) : null}
            {totals.discount > 0 ? (
              <Row label="تخفیف" value={`- ${money.format(totals.discount)}`} />
            ) : null}
            {totals.tax > 0 ? (
              <Row label="مالیات" value={money.format(totals.tax)} />
            ) : null}
            {feeNum > 0 ? (
              <Row label="هزینهٔ ارسال" value={money.format(feeNum)} />
            ) : null}
            <Row label="جمع کل" value={money.format(totals.total)} bold />
          </dl>

          {/*
            How the money is taken is asked in the payment step, not here. Six
            payment ways plus a tip field held ~300px of the panel at all times —
            on a laptop that is what squeezed the cart down to a single visible
            line — and every one of those controls only matters once the cashier
            has decided to settle. Pressing «دریافت وجه» is where they are now.
          */}
          <CheckoutActions
            blocker={blocker}
            busy={busy}
            onPay={() => startCheckout("payment")}
            onOpenOrder={() => startCheckout("order")}
          />
        </div>
      </div>

      {/*
        The phone's one-line summary of where the order stands: what is in it,
        what it comes to, and which table or type it is for. It stays visible over
        the product grid so the cashier never has to open the sheet to check —
        opening it is now only for the order's details and the payment.
      */}
      <div className="sticky bottom-[calc(5rem+env(safe-area-inset-bottom))] z-20 md:hidden">
        <button
          type="button"
          onClick={() => setCartSheetOpen(true)}
          className={
            // `pe-[5.25rem]`: the assistant's floating button rests in this
            // same band at the inline end, so the total is padded clear of it.
            "flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl ps-4 pe-[5.25rem] text-sm font-bold shadow-[0_8px_20px_rgba(233,161,27,0.22)] transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 motion-reduce:transition-none " +
            (cart.length === 0
              ? "border border-[#EAE8E2] bg-white text-[#5E5B55] shadow-none"
              : "bg-[#E9A11B] text-[#252522]")
          }
          aria-label={
            cart.length === 0
              ? "باز کردن سبد خرید؛ سبد خالی است"
              : `باز کردن سبد خرید؛ ${toPersianDigits(cartItemCount)} قلم، ${money.format(totals.total)}`
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <ShoppingBagIcon className="size-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate text-start">
              {cart.length === 0
                ? "سبد خالی است"
                : `${toPersianDigits(cartItemCount)} قلم در سبد`}
              <span className="block truncate text-[11px] font-normal opacity-80">
                {orderType === "dine_in"
                  ? "حضوری — " + tableLabel
                  : orderType === "takeaway"
                    ? "بیرون‌بر"
                    : "ارسالی"}
              </span>
            </span>
          </span>
          <span className="shrink-0">{money.format(totals.total)}</span>
        </button>
      </div>

      <Sheet open={cartSheetOpen} onOpenChange={setCartSheetOpen}>
        <SheetContent
          side="bottom"
          className="flex max-h-[92dvh] flex-col gap-0 rounded-t-3xl border-[#EAE8E2] p-0 data-[state=open]:duration-200 data-[state=closed]:duration-200 md:hidden"
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <SheetTitle>سبد خرید</SheetTitle>
            <ErrorBox>{error}</ErrorBox>
          </div>
          {/* One scroll region keeps the cart usable on short phone screens. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="border-b border-border p-4">
              <OrderTypeTabs value={orderType} onChange={changeOrderType} />
              {orderType === "dine_in" ? (
                <>
                  <TableField
                    label={tableLabel}
                    chosen={tableId !== ""}
                    occupied={isTableOccupied(selectedTable?.status)}
                    onPick={() => setTablePickerFor("select")}
                  />
                  <label className="mt-3 block text-xs font-semibold text-[#5E5B55]" htmlFor="pos-mobile-guest-count">
                    تعداد مهمان
                    <input
                      id="pos-mobile-guest-count"
                      className={inputClass + " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"}
                      dir="ltr"
                      inputMode="numeric"
                      value={guestCount}
                      onChange={(event) => setGuestCount(event.target.value)}
                      placeholder="اختیاری"
                    />
                  </label>
                </>
              ) : null}
              {orderType === "delivery" ? (
                <div className="mt-3 space-y-3">
                  <label
                    className="block text-xs font-semibold text-[#5E5B55]"
                    htmlFor="pos-mobile-delivery-address"
                  >
                    آدرس تحویل
                    <textarea
                      id="pos-mobile-delivery-address"
                      className={
                        inputClass +
                        " mt-1 h-auto min-h-20 border-[#EAE8E2] bg-[#FCFCFA] py-2"
                      }
                      rows={2}
                      value={deliveryAddress}
                      onChange={(event) =>
                        setDeliveryAddress(event.target.value)
                      }
                      placeholder="آدرس کامل تحویل"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label
                      className="block text-xs font-semibold text-[#5E5B55]"
                      htmlFor="pos-mobile-delivery-phone"
                    >
                      تلفن مشتری
                      <input
                        id="pos-mobile-delivery-phone"
                        className={
                          inputClass +
                          " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"
                        }
                        dir="ltr"
                        inputMode="tel"
                        value={deliveryPhone}
                        onChange={(event) =>
                          setDeliveryPhone(event.target.value)
                        }
                        placeholder="اختیاری"
                      />
                    </label>
                    <label
                      className="block text-xs font-semibold text-[#5E5B55]"
                      htmlFor="pos-mobile-delivery-fee"
                    >
                      هزینهٔ ارسال
                      <input
                        id="pos-mobile-delivery-fee"
                        className={
                          inputClass +
                          " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"
                        }
                        dir="ltr"
                        inputMode="numeric"
                        value={deliveryFee}
                        onChange={(event) => setDeliveryFee(event.target.value)}
                        placeholder={money.unitLabel}
                      />
                    </label>
                  </div>
                  <label className="block text-xs font-semibold text-[#5E5B55]">
                    پیک
                    <SearchableSelect
                      className={
                        inputClass +
                        " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"
                      }
                      value={deliveryCourierId}
                      onChange={setDeliveryCourierId}
                      ariaLabel="پیک ارسال"
                      options={[
                        { value: "", label: "تخصیص پیک بعداً" },
                        ...couriers.map((courier) => ({
                          value: courier.id,
                          label: courier.name,
                        })),
                      ]}
                    />
                  </label>
                </div>
              ) : null}
              <CustomerField
                value={customer?.id ?? ""}
                options={customerOptions}
                onChange={selectCustomer}
                onQueryChange={setCustomerQuery}
              />
            </div>
            <div className="p-4">
              {cart.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  سبد خرید خالی است.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {cart.map((line) => {
                    const breakdown = linePriceBreakdown({
                      unitPrice: line.unitPrice,
                      modifierDeltas: line.modifiers.map(
                        (modifier) => modifier.priceDelta,
                      ),
                      quantity: line.quantity,
                    });
                    return (
                      <li
                        key={line.key}
                        className={
                          "rounded-xl border p-3 " +
                          (line.modifiers.length > 0
                            ? "border-[#F2D097] bg-[#FFFCF5]"
                            : "border-[#EAE8E2] bg-white")
                        }
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-bold text-[#252522]">
                              {line.name}
                            </p>
                            <p className="mt-0.5 text-xs text-[#77756F]">
                              {money.format(breakdown.unit)} هر واحد
                            </p>
                          </div>
                          <p className="shrink-0 text-sm font-bold text-[#B97905]">
                            {money.format(breakdown.total)}
                          </p>
                        </div>
                        <ModifierBadges
                          modifiers={line.modifiers}
                          tone="amber"
                          className="mt-2"
                        />
                        {line.note ? (
                          <p className="mt-2 text-xs text-[#77756F]">
                            یادداشت: {line.note}
                          </p>
                        ) : null}
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            aria-label="کاهش تعداد"
                            onClick={() => setQty(line.key, line.quantity - 1)}
                            className="flex size-11 items-center justify-center rounded-lg bg-muted"
                          >
                            −
                          </button>
                          <span className="w-8 text-center font-semibold">
                            {toPersianDigits(line.quantity)}
                          </span>
                          <button
                            type="button"
                            aria-label="افزایش تعداد"
                            onClick={() => setQty(line.key, line.quantity + 1)}
                            className="flex size-11 items-center justify-center rounded-lg bg-muted"
                          >
                            +
                          </button>
                          <button
                            type="button"
                            onClick={() => removeLine(line.key)}
                            className="ms-auto px-2 py-1 text-sm text-destructive"
                          >
                            حذف
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="border-t border-border p-4">
              <div className="mb-3 flex gap-2">
                <SearchableSelect
                  value={discountType}
                  onChange={(value) =>
                    setDiscountType(value as "" | "percent" | "amount")
                  }
                  ariaLabel="نوع تخفیف"
                  options={[
                    { value: "", label: "بدون تخفیف" },
                    { value: "percent", label: "درصدی" },
                    { value: "amount", label: "مبلغ ثابت" },
                  ]}
                />
                {discountType ? (
                  <input
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    value={discountValue}
                    onChange={(event) => setDiscountValue(event.target.value)}
                    placeholder={discountType === "percent" ? "درصد" : money.unit === "rial" ? "ریال" : "تومان"}
                    aria-label="مقدار تخفیف"
                  />
                ) : null}
              </div>
              {cartAddOnTotal !== 0 ? (
                <Row
                  label="از این مبلغ، افزودنی‌ها"
                  value={formatModifierDelta(cartAddOnTotal, { unit: money.unit })}
                />
              ) : null}
            </div>
          </div>
          <div className="shrink-0 border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-bold text-[#5E5B55]">جمع کل</span>
              <span className="text-base font-bold text-[#252522]">
                {money.format(totals.total)}
              </span>
            </div>
            <CheckoutActions
              blocker={blocker}
              busy={busy}
              onPay={() => startCheckout("payment")}
              onOpenOrder={() => startCheckout("order")}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/*
        One dialog carries the whole close of a sale: it reviews the order, and
        once submit() succeeds it turns into that order's confirmation instead
        of taking over the page. Dismissing it is what starts the next order —
        the POS behind it is already empty by then.
      */}
      <Dialog
        open={reviewOpen || result !== null}
        onOpenChange={(open) => (open ? setReviewOpen(true) : closeCheckout())}
      >
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
          {result ? (
            <CheckoutConfirmation result={result} onDone={closeCheckout} />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {checkoutIntent === "payment"
                    ? "تأیید دریافت وجه"
                    : "بررسی سفارش"}
                </DialogTitle>
                <DialogDescription>
                  {checkoutIntent === "payment"
                    ? "پرداخت فقط پس از ثبت موفق سفارش به جریان موجود پرداخت ارسال می‌شود."
                    : "پیش از ثبت، جزئیات سفارش را بررسی کنید."}
                </DialogDescription>
                <ErrorBox>{error}</ErrorBox>
              </DialogHeader>
              <section aria-label="اقلام سفارش">
                <h3 className="mb-2 text-xs font-bold text-[#5E5B55]">
                  اقلام سفارش
                </h3>
                <ul className="space-y-2">
                  {cart.map((line) => (
                    <CheckoutLineRow key={line.key} line={line} />
                  ))}
                </ul>
              </section>
              <dl className="space-y-2 text-sm">
                <Row
                  label="نوع سفارش"
                  value={
                    orderType === "dine_in"
                      ? "حضوری"
                      : orderType === "takeaway"
                        ? "بیرون‌بر"
                        : "ارسالی"
                  }
                />
                {orderType === "dine_in" ? (
                  <Row label="میز" value={tableLabel} />
                ) : null}
                {orderType === "delivery" ? (
                  <Row
                    label="آدرس"
                    value={deliveryAddress.trim() || "ثبت نشده"}
                  />
                ) : null}
                <Row label="مشتری" value={customer?.name ?? "بدون مشتری"} />
                <Row
                  label="تعداد اقلام"
                  value={toPersianDigits(cartItemCount)}
                />
                {cartAddOnTotal !== 0 ? (
                  <Row
                    label="افزودنی‌ها"
                    value={formatModifierDelta(cartAddOnTotal, { unit: money.unit })}
                  />
                ) : null}
                <Row
                  label="مبلغ قابل پرداخت"
                  value={money.format(totals.total)}
                  bold
                />
                {checkoutIntent === "payment" && tipNum > 0 ? (
                  <>
                    <Row label="انعام" value={money.format(tipNum)} />
                    <Row
                      label="مبلغ دریافتی"
                      value={money.format(totals.total + tipNum)}
                      bold
                    />
                  </>
                ) : null}
              </dl>
              {/*
                The payment step, in the dialog that *is* the payment step. The
                cart panel used to carry these permanently, whether or not the
                cashier was settling; here they are asked for once, next to the
                amount they apply to.
              */}
              {checkoutIntent === "payment" ? (
                <section aria-label="روش دریافت وجه">
                  <PaymentWays
                    methods={paymentMethods}
                    draft={paymentDraft}
                    onChange={setPaymentDraft}
                    due={totals.total}
                    disabled={busy}
                    idPrefix="pos-checkout"
                  />
                  <label
                    htmlFor="pos-checkout-tip"
                    className="mt-3 block text-xs font-bold text-[#5E5B55]"
                  >
                    انعام{" "}
                    <span className="font-normal text-[#8B8A85]">
                      (اختیاری، تومان)
                    </span>
                  </label>
                  <input
                    id="pos-checkout-tip"
                    className={
                      inputClass + " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"
                    }
                    dir="ltr"
                    inputMode="numeric"
                    value={tipInput}
                    onChange={(event) => setTipInput(event.target.value)}
                    placeholder="۰"
                  />
                </section>
              ) : null}
              <DialogFooter>
                <button
                  type="button"
                  onClick={() => setReviewOpen(false)}
                  className="min-h-11 rounded-lg border border-input px-4 text-sm font-medium"
                >
                  بازگشت
                </button>
                <button
                  type="button"
                  disabled={busy || cart.length === 0}
                  onClick={() => {
                    void submit(checkoutIntent);
                  }}
                  className="min-h-12 rounded-xl bg-[#E9A11B] px-4 text-sm font-bold text-[#252522] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 disabled:opacity-55"
                >
                  {busy
                    ? "در حال ثبت…"
                    : checkoutIntent === "payment"
                      ? "تأیید دریافت وجه"
                      : "تأیید و ثبت سفارش"}
                </button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {pickerItem ? (
        <ModifierPicker
          itemName={pickerItem.name}
          itemPrice={Number(pickerItem.price)}
          selectQuantity
          groups={attachedGroups(pickerItem.id)}
          tone="amber"
          onCancel={() => setPickerItem(null)}
          onConfirm={(modifierIds, note, quantity) => {
            addToCart(pickerItem, modifierIds, note, quantity);
            setPickerItem(null);
          }}
        />
      ) : null}
      {/*
        Choosing the table is the last question of a dine-in sale, so confirming
        it carries straight on into whatever asked: «ثبت سفارش باز» places the
        order right there, «دریافت وجه» opens its review. The chosen table is
        passed to submit() rather than read back from state, which this tick has
        not yet re-rendered with.
      */}
      <TablePickerDialog
        open={tablePickerFor !== null}
        intent={tablePickerFor ?? "select"}
        tables={tables}
        selectedTableId={tableId}
        guestCount={guestCount}
        onCancel={() => setTablePickerFor(null)}
        onConfirm={(chosenTableId, chosenGuestCount) => {
          setTableId(chosenTableId);
          setGuestCount(chosenGuestCount);
          const pending = tablePickerFor;
          setTablePickerFor(null);
          if (pending === "order") {
            void submit("order", {
              tableId: chosenTableId,
              guestCount: chosenGuestCount,
            });
          } else if (pending === "payment") {
            setReviewOpen(true);
          }
        }}
      />
    </div>
  );
}

/** One cart line as it reads in the review dialog and in the confirmation: what it is, its add-ons, and what it costs. */
function CheckoutLineRow({ line }: { line: CartUiLine }) {
  const money = useMoney();
  const breakdown = linePriceBreakdown({
    unitPrice: line.unitPrice,
    modifierDeltas: line.modifiers.map((modifier) => modifier.priceDelta),
    quantity: line.quantity,
  });
  return (
    <li
      className={
        "rounded-xl border p-2.5 " +
        (line.modifiers.length > 0
          ? "border-[#F2D097] bg-[#FFFCF5]"
          : "border-[#EAE8E2] bg-[#FCFCFA]")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-[#252522]">
            {line.name}{" "}
            <span className="text-xs font-semibold text-[#77756F]">
              × {toPersianDigits(line.quantity)}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-[#77756F]">
            {money.format(breakdown.unit)} هر واحد
          </p>
        </div>
        <p className="shrink-0 text-sm font-bold text-[#B97905]">
          {money.format(breakdown.total)}
        </p>
      </div>
      <ModifierBadges
        modifiers={line.modifiers}
        tone="amber"
        className="mt-2"
      />
      {line.note ? (
        <p className="mt-2 text-[11px] text-[#77756F]">یادداشت: {line.note}</p>
      ) : null}
    </li>
  );
}

/**
 * What the review dialog becomes once the order is in: the receipt for the sale
 * that just closed, restated line by line (add-ons included) so the cashier can
 * check it against what the customer asked for before starting the next one.
 */
function CheckoutConfirmation({
  result,
  onDone,
}: {
  result: CheckoutResult;
  onDone: () => void;
}) {
  const money = useMoney();
  const settled = result.paid && !result.queued;
  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <span
            className={
              "flex size-11 shrink-0 items-center justify-center rounded-2xl " +
              (settled
                ? "bg-[#EAF8EF] text-[#258A4C]"
                : "bg-[#FFF1D8] text-[#B97905]")
            }
            aria-hidden="true"
          >
            {settled ? (
              <CheckIcon className="size-6" />
            ) : (
              <ReceiptTextIcon className="size-6" />
            )}
          </span>
          <div className="min-w-0">
            <DialogTitle>
              {result.queued
                ? "سفارش در صف همگام‌سازی ثبت شد"
                : result.paid
                  ? "پرداخت ثبت و سفارش تکمیل شد"
                  : result.paymentPending
                    ? "سفارش ثبت شد؛ پرداخت تکمیل نشد"
                    : "سفارش باز ثبت شد"}
            </DialogTitle>
            <DialogDescription>
              {result.queued
                ? result.paymentPending
                  ? "دریافت وجه را پس از اتصال از بخش سفارش‌ها تکمیل کنید."
                  : "با اتصال مجدد، سفارش بدون از دست رفتن داده‌ها ارسال می‌شود."
                : result.paid
                  ? "رسید و کشوی پول، در صورت اتصال چاپگر، اجرا شدند."
                  : result.paymentPending
                    ? result.paymentError ||
                      "پرداخت را از بخش سفارش‌ها ادامه دهید."
                    : "سفارش در فهرست سفارش‌های باز در دسترس است."}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="rounded-2xl border border-[#F2D097] bg-[#FFF9EE] p-4 text-center">
        <p className="text-2xl font-bold text-[#252522]">
          {toPersianDigits(
            result.orderNumber
              ? formatQueueLabel(result.type, result.orderNumber)
              : "سفارش جدید",
          )}
        </p>
        <p className="mt-1 text-xs text-[#77756F]">
          {result.type === "dine_in"
            ? "حضوری" + (result.tableName ? " — " + result.tableName : "")
            : result.type === "takeaway"
              ? "بیرون‌بر"
              : "ارسالی"}
        </p>
        <p className="mt-2 text-lg font-bold text-[#B97905]">
          {money.format(result.total)}
        </p>
      </div>

      {result.lines.length > 0 ? (
        <section aria-label="اقلام سفارش ثبت‌شده">
          <h3 className="mb-2 text-xs font-bold text-[#5E5B55]">
            اقلام ثبت‌شده
          </h3>
          <ul className="space-y-2">
            {result.lines.map((line) => (
              <CheckoutLineRow key={line.key} line={line} />
            ))}
          </ul>
        </section>
      ) : null}

      <DialogFooter>
        <button
          type="button"
          onClick={onDone}
          className="min-h-12 w-full rounded-xl bg-[#E9A11B] px-5 text-sm font-bold text-[#252522] transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 motion-reduce:transition-none"
        >
          بستن و شروع سفارش بعدی
        </button>
      </DialogFooter>
    </>
  );
}

function PosLoadingState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  if (!loading && error) {
    return (
      <section className="mx-auto flex min-h-[55dvh] max-w-md flex-col items-center justify-center rounded-2xl border border-[#EAE8E2] bg-white p-6 text-center">
        <WifiOffIcon className="size-7 text-[#B97905]" aria-hidden="true" />
        <h1 className="mt-4 text-base font-bold text-[#252522]">
          صندوق در دسترس نیست
        </h1>
        <p className="mt-2 text-sm leading-6 text-[#77756F]">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 min-h-12 rounded-xl bg-[#E9A11B] px-5 text-sm font-bold text-[#252522] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
        >
          تلاش دوباره
        </button>
      </section>
    );
  }

  return (
    <div
      className="flex min-h-[calc(100dvh-6rem)] flex-col gap-3 md:h-[calc(100dvh-2rem)]"
      aria-busy="true"
      aria-label="در حال بارگذاری صندوق"
    >
      <div className="grid gap-3 rounded-2xl border border-[#EAE8E2] bg-white p-3 md:grid-cols-[0.8fr_1.2fr_0.7fr]">
        <div className="ops-skeleton h-12 rounded-xl" />
        <div className="ops-skeleton h-12 rounded-xl" />
        <div className="ops-skeleton h-12 rounded-xl" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-[#EAE8E2] bg-white p-4">
          <div className="flex gap-2 overflow-hidden">
            {[1, 2, 3, 4].map((item) => (
              <div
                key={item}
                className="ops-skeleton h-14 w-28 shrink-0 rounded-xl"
              />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 15 }, (_, index) => (
              <div key={index} className="ops-skeleton min-h-32 rounded-2xl" />
            ))}
          </div>
        </section>
        <aside className="hidden w-[23rem] shrink-0 rounded-2xl border border-[#EAE8E2] bg-white p-4 md:block">
          <div className="ops-skeleton h-7 w-28 rounded-lg" />
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[1, 2, 3].map((item) => (
              <div key={item} className="ops-skeleton h-12 rounded-xl" />
            ))}
          </div>
          <div className="mt-5 space-y-3">
            {[1, 2, 3].map((item) => (
              <div key={item} className="ops-skeleton h-16 rounded-xl" />
            ))}
          </div>
          <div className="mt-6 space-y-2">
            <div className="ops-skeleton h-5 rounded-lg" />
            <div className="ops-skeleton h-5 rounded-lg" />
            <div className="ops-skeleton h-14 rounded-xl" />
          </div>
        </aside>
      </div>
    </div>
  );
}

const ORDER_TYPE_TABS: { value: OrderType; label: string }[] = [
  { value: "dine_in", label: "حضوری" },
  { value: "takeaway", label: "بیرون‌بر" },
  { value: "delivery", label: "ارسالی" },
];

/**
 * Where the order is going, as one control on every device.
 *
 * The cart panel wrote out three buttons by hand and the mobile sheet mapped
 * over the same three with a different palette — the phone's selected tab came
 * out in the theme's teal while every other selected thing in the till is amber.
 */
function OrderTypeTabs({
  value,
  onChange,
}: {
  value: OrderType;
  onChange: (next: OrderType) => void;
}) {
  return (
    <div
      className="mb-3 grid grid-cols-3 gap-2 text-sm font-medium"
      role="group"
      aria-label="نوع سفارش"
    >
      {ORDER_TYPE_TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          aria-pressed={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={`min-h-12 rounded-lg px-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 ${
            value === tab.value
              ? "bg-[#FFF1D8] font-bold text-[#9B6700]"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** What each unmet requirement says on the button that is waiting for it. */
const BLOCKER_LABELS: Record<PosCheckoutRequirement, string> = {
  empty_cart: "ابتدا آیتمی به سبد اضافه کنید",
  table_required: "انتخاب میز و ادامه",
  delivery_address_required: "آدرس تحویل را وارد کنید",
};

/**
 * The end of the walkthrough: keep the order open, or take the money now.
 *
 * Both buttons live here so the cart panel and the mobile sheet can never offer
 * different wording or a different disabled rule — they used to be two copies.
 * A missing table does *not* disable them: it relabels them, and the press opens
 * the table prompt and then carries on into the checkout it interrupted.
 */
function CheckoutActions({
  blocker,
  busy,
  onPay,
  onOpenOrder,
}: {
  blocker: PosCheckoutRequirement | null;
  busy: boolean;
  onPay: () => void;
  onOpenOrder: () => void;
}) {
  const stopped =
    blocker === "empty_cart" || blocker === "delivery_address_required";
  const disabled = busy || stopped;

  return (
    <>
      <button
        type="button"
        onClick={onPay}
        disabled={disabled}
        className="mt-3 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#E9A11B] px-4 text-sm font-bold text-[#252522] transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 disabled:opacity-55 motion-reduce:transition-none"
      >
        <ReceiptTextIcon className="size-5" aria-hidden="true" />
        {blocker ? BLOCKER_LABELS[blocker] : "دریافت وجه و تکمیل"}
      </button>
      <button
        type="button"
        onClick={onOpenOrder}
        disabled={disabled}
        className="mt-2 min-h-12 w-full rounded-xl border border-[#EAE8E2] bg-white px-4 text-sm font-semibold text-[#5E5B55] transition duration-200 hover:bg-[#FCFCFA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 disabled:opacity-55 motion-reduce:transition-none"
      >
        {busy ? "در حال ثبت…" : "ثبت سفارش باز (بدون دریافت وجه)"}
      </button>
    </>
  );
}

/**
 * Which table this sale is for, in the desktop panel and the mobile sheet alike.
 * The row states the answer so it can be read without reopening anything, and a
 * press hands the question to the one picker — this deliberately draws no grid
 * of its own, which is how the two used to drift apart.
 */
function TableField({
  label,
  chosen,
  occupied,
  onPick,
}: {
  label: string;
  chosen: boolean;
  occupied: boolean;
  onPick: () => void;
}) {
  return (
    <div className="mt-3">
      <span className="block text-xs font-semibold text-[#5E5B55]">میز</span>
      <button
        type="button"
        onClick={onPick}
        className={
          "mt-1 flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 " +
          (chosen
            ? "border-[#E9A11B] bg-[#FFF1D8] text-[#9B6700]"
            : "border-[#EAE8E2] bg-[#FCFCFA] text-[#77756F] hover:border-[#E9A11B]/60")
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 text-xs font-semibold text-[#9B6700]">
          {chosen ? "تغییر میز" : "انتخاب میز"}
        </span>
      </button>
      {occupied ? (
        <p className="mt-1 text-[11px] text-[#77756F]">
          این میز مهمان دارد؛ این سفارش صورت‌حساب جداگانهٔ خودش را می‌گیرد.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The till's customer picker, shared by the desktop cart panel and the mobile
 * cart sheet so both send the same field. Optional by design — a walk-in sale
 * stays anonymous, and picking someone only attributes the order to them.
 */
function CustomerField({
  value,
  options,
  onChange,
  onQueryChange,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  onQueryChange: (query: string) => void;
}) {
  return (
    <label className="mt-3 block text-xs font-semibold text-[#5E5B55]">
      مشتری <span className="font-normal text-[#8B8A85]">(اختیاری)</span>
      <SearchableSelect
        className={inputClass + " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"}
        value={value}
        onChange={onChange}
        onQueryChange={onQueryChange}
        options={options}
        ariaLabel="انتخاب مشتری"
        placeholder="بدون مشتری"
        searchPlaceholder="جستجوی نام یا شماره…"
        emptyText="مشتری‌ای یافت نشد."
      />
    </label>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${bold ? "text-base font-bold" : "text-muted-foreground"}`}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
