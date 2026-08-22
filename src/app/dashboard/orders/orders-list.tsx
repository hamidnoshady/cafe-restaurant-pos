"use client";

import { useCallback, useEffect, useMemo, useState, useDeferredValue } from "react";
import { InfoIcon, RefreshCwIcon, SearchIcon, ShoppingBagIcon, UserIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali, isoDateInTimeZone } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { formatQueueLabel } from "@/lib/orders";
import {
  linePriceBreakdown,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import { useRealtime } from "../use-realtime";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api } from "../ui";
import { BackdatedOrderPanel } from "./backdated-order-panel";
import { OrderDetailModal } from "./order-detail-modal";

type OrderStatus = "open" | "held" | "completed" | "voided";
type OrderType = "dine_in" | "takeaway" | "delivery";

/** A row of either list the orders screen shows: the open queue, or an order closed this shift. */
interface OrderRow {
  id: string;
  order_number: number;
  type: OrderType;
  status: OrderStatus;
  table_name: string | null;
  /** Whom the sale is attributed to — null for the walk-in that most orders are. */
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  guest_count: number | null;
  total: string | number;
  opened_at: string;
  /** Set once the order is paid or voided — null for everything still in the queue. */
  closed_at: string | null;
}

interface OrderItem {
  id: string;
  name_snapshot: string;
  unit_price: string | number;
  quantity: number;
  status: string;
  note: string | null;
}

/** An add-on snapshot as the order API returns it, priced at the moment of sale. */
interface OrderModifier {
  id: string;
  order_item_id: string;
  name_snapshot: string;
  price_delta: string | number;
}

interface DetailedOrder extends OrderRow {
  subtotal: string | number;
  discount: string | number;
  tax: string | number;
  note: string | null;
}

interface OrderDetailsResponse {
  order: DetailedOrder;
  items: OrderItem[];
  modifiers: OrderModifier[];
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  open: "باز",
  held: "نگه‌داشته",
  completed: "تکمیل‌شده",
  voided: "باطل‌شده",
};

/**
 * The branch's trading day as the orders route reports it. Absent (null) for a
 * branch with no business day configured, which keeps this screen's original
 * calendar-day-plus-open-shift window untouched.
 */
interface BusinessDayWindow {
  enabled: boolean;
  businessDate: string;
  /** Where the closed list starts: the day's start, or whatever ended the night early. */
  windowStart: string;
  /** "shift" = the cashier cashed up, "manual" = «بستن روز کاری», null = still running. */
  closedBy: "manual" | "shift" | null;
  manuallyClosed: boolean;
}

/** One of the branch's recent shifts — only owners/managers are sent these. */
interface ShiftOption {
  id: string;
  employeeName: string;
  startedAt: string;
  endedAt: string | null;
}

/** Spans days, so it carries the Jalali date — the same wording the reports tab uses. */
function shiftOptionLabel(shift: ShiftOption): string {
  const start = toPersianDigits(
    formatJalali(shift.startedAt, { withMonthName: true, withTime: true }),
  );
  const end = shift.endedAt
    ? toPersianDigits(orderTimeLabel(shift.endedAt))
    : "در حال انجام";
  return `${shift.employeeName} · ${start} تا ${end}`;
}

/** Closed = it left the queue. The pair `listSettledOrdersInWindow` reads back. */
const CLOSED_STATUSES: OrderStatus[] = ["completed", "voided"];

function isClosed(order: OrderRow): boolean {
  return CLOSED_STATUSES.includes(order.status);
}

/** Voided orders are muted rather than amber: they are history, not takings. */
function statusBadgeClass(status: OrderStatus): string {
  return status === "voided"
    ? "bg-[#F3F2EF] text-[#5E5B55]"
    : status === "completed"
      ? "bg-[#E7F1E9] text-[#2F6B41]"
      : "bg-[#FFF1D8] text-[#9B6700]";
}

const TYPE_LABELS: Record<OrderType, string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
};

/**
 * The day an order belongs to, as the date filter's calendar counts days.
 * Tehran rather than UTC: JalaliDatePicker hands back the ISO date behind the
 * Jalali day the user tapped, and that calendar is Tehran's (todayJalali), so
 * bucketing in UTC would drop every order rung up after 20:30 local into the
 * previous day and hide it.
 */
function orderDateValue(value: string): string | null {
  return isoDateInTimeZone(value);
}

function orderTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "زمان نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function orderDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "تاریخ نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    day: "numeric",
    month: "long",
  }).format(date);
}

function elapsedLabel(value: string): string | null {
  const openedAt = new Date(value).getTime();
  if (Number.isNaN(openedAt)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - openedAt) / 60_000));
  if (minutes < 1) return "همین حالا";
  if (minutes < 60) return `${toPersianDigits(minutes)} دقیقه`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder
    ? `${toPersianDigits(hours)} ساعت و ${toPersianDigits(remainder)} دقیقه`
    : `${toPersianDigits(hours)} ساعت`;
}

function OrderRowsSkeleton() {
  return (
    <div
      className="divide-y divide-[#EAE8E2]"
      aria-label="در حال بارگذاری سفارش‌ها"
      aria-busy="true"
    >
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="flex min-h-[76px] items-center justify-between gap-4 px-4 py-3 md:min-h-[82px] xl:min-h-[88px]"
        >
          <div className="min-w-0 flex-1">
            <div className="ops-skeleton h-4 w-24 rounded" />
            <div className="ops-skeleton mt-3 h-3 w-40 max-w-full rounded" />
          </div>
          <div className="ops-skeleton h-8 w-16 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div
      className="space-y-4"
      aria-label="در حال بارگذاری جزئیات سفارش"
      aria-busy="true"
    >
      <div className="ops-skeleton h-5 w-28 rounded" />
      <div className="grid grid-cols-2 gap-2">
        <div className="ops-skeleton h-16 rounded-xl" />
        <div className="ops-skeleton h-16 rounded-xl" />
      </div>
      <div className="space-y-3 border-y border-[#EAE8E2] py-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="flex items-center justify-between gap-3">
            <div className="ops-skeleton h-3 w-28 rounded" />
            <div className="ops-skeleton h-3 w-12 rounded" />
          </div>
        ))}
      </div>
      <div className="ops-skeleton h-12 w-full rounded-xl" />
    </div>
  );
}

function OrderDetailsPanel({
  selectedOrder,
  detail,
  isLoading,
  error,
  onRetry,
  onOpenDetail,
}: {
  selectedOrder: OrderRow | null;
  detail: OrderDetailsResponse | null;
  isLoading: boolean;
  error: string;
  onRetry: () => void;
  onOpenDetail: (orderId: string) => void;
}) {
  const money = useMoney();
  if (!selectedOrder) {
    return (
      <aside
        className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-[#EAE8E2] bg-[#FCFCFA] p-6 text-center"
        aria-label="جزئیات سفارش"
      >
        <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF1D8] text-[#9B6700]">
          <ShoppingBagIcon className="size-5" aria-hidden="true" />
        </span>
        <h2 className="mt-4 text-sm font-bold text-[#252522]">
          سفارشی برای نمایش نیست
        </h2>
        <p className="mt-2 max-w-60 text-xs leading-6 text-[#77756F]">
          برای دیدن خلاصه و ادامهٔ پیگیری، یک سفارش را از فهرست انتخاب کنید.
        </p>
      </aside>
    );
  }

  const selectedDetail = detail?.order.id === selectedOrder.id ? detail : null;
  const order = selectedDetail?.order ?? selectedOrder;
  const activeItems =
    selectedDetail?.items.filter((item) => item.status !== "voided") ?? [];
  const itemCount = activeItems.reduce(
    (count, item) => count + item.quantity,
    0,
  );
  const addOnsByItem = new Map<string, DisplayModifier[]>();
  for (const modifier of selectedDetail?.modifiers ?? []) {
    const current = addOnsByItem.get(modifier.order_item_id) ?? [];
    current.push({
      name: modifier.name_snapshot,
      priceDelta: Number(modifier.price_delta),
    });
    addOnsByItem.set(modifier.order_item_id, current);
  }
  const closed = isClosed(order);
  // A closed order's "3 hours ago" is noise; when it closed is the useful fact.
  const elapsed = closed ? null : elapsedLabel(order.opened_at);

  return (
    <aside
      className="rounded-2xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_3px_rgba(37,37,34,0.03)] md:sticky md:top-0 md:max-h-[calc(100dvh-4.5rem)] md:overflow-y-auto"
      aria-label="جزئیات سفارش انتخاب‌شده"
    >
      <div className="flex items-start justify-between gap-3 border-b border-[#EAE8E2] pb-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[#77756F]">سفارش انتخاب‌شده</p>
          <h2 className="mt-1 text-xl font-bold text-[#252522]">
            {toPersianDigits(formatQueueLabel(order.type, order.order_number))}
          </h2>
        </div>
        <span
          className={`inline-flex min-h-8 shrink-0 items-center rounded-lg px-2.5 text-xs font-bold ${statusBadgeClass(order.status)}`}
        >
          {STATUS_LABELS[order.status]}
        </span>
      </div>

      {isLoading && !selectedDetail ? (
        <div className="pt-4">
          <DetailSkeleton />
        </div>
      ) : error && !selectedDetail ? (
        <div
          className="mt-4 rounded-xl border border-[#E9A11B]/25 bg-[#FFF9EE] p-3"
          role="status"
        >
          <p className="text-sm font-semibold text-[#5E5B55]">
            جزئیات سفارش به‌روز نشد
          </p>
          <p className="mt-1 text-xs leading-5 text-[#77756F]">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 min-h-11 rounded-lg px-2 text-xs font-bold text-[#9B6700] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
          >
            تلاش دوباره
          </button>
        </div>
      ) : (
        <>
          {error ? (
            <div
              className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[#E9A11B]/25 bg-[#FFF9EE] p-3"
              role="status"
            >
              <p className="text-xs leading-5 text-[#5E5B55]">{error}</p>
              <button
                type="button"
                onClick={onRetry}
                className="min-h-11 shrink-0 rounded-lg px-2 text-xs font-bold text-[#9B6700] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
              >
                تلاش دوباره
              </button>
            </div>
          ) : null}
          <dl className="grid grid-cols-2 gap-2 py-4">
            <div className="rounded-xl bg-[#FCFCFA] p-3">
              <dt className="text-[11px] text-[#77756F]">نوع سفارش</dt>
              <dd className="mt-1 text-sm font-bold text-[#252522]">
                {TYPE_LABELS[order.type]}
              </dd>
            </div>
            <div className="rounded-xl bg-[#FCFCFA] p-3">
              <dt className="text-[11px] text-[#77756F]">مبلغ سفارش</dt>
              <dd className="mt-1 text-sm font-bold text-[#B97905]">
                {money.format(Number(order.total))}
              </dd>
            </div>
            {order.table_name ? (
              <div className="rounded-xl bg-[#FCFCFA] p-3">
                <dt className="text-[11px] text-[#77756F]">میز</dt>
                <dd className="mt-1 truncate text-sm font-bold text-[#252522]">
                  {order.table_name}
                </dd>
              </div>
            ) : null}
            {order.customer_name ? (
              <div className="col-span-2 rounded-xl bg-[#FCFCFA] p-3">
                <dt className="text-[11px] text-[#77756F]">مشتری</dt>
                <dd className="mt-1 truncate text-sm font-bold text-[#252522]">
                  {order.customer_name}
                  {order.customer_phone ? (
                    <span className="font-normal text-[#77756F]">
                      {" · "}
                      {toPersianDigits(order.customer_phone)}
                    </span>
                  ) : null}
                </dd>
              </div>
            ) : null}
            <div className="rounded-xl bg-[#FCFCFA] p-3">
              <dt className="text-[11px] text-[#77756F]">زمان ثبت</dt>
              <dd className="mt-1 text-sm font-bold text-[#252522]">
                {orderTimeLabel(order.opened_at)}
              </dd>
            </div>
            {order.closed_at ? (
              <div className="rounded-xl bg-[#FCFCFA] p-3">
                <dt className="text-[11px] text-[#77756F]">
                  {order.status === "voided" ? "زمان ابطال" : "زمان تسویه"}
                </dt>
                <dd className="mt-1 text-sm font-bold text-[#252522]">
                  {orderTimeLabel(order.closed_at)}
                </dd>
              </div>
            ) : null}
          </dl>

          <section
            className="border-y border-[#EAE8E2] py-4"
            aria-label="اقلام سفارش"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-sm font-bold text-[#252522]">اقلام سفارش</h3>
              {selectedDetail ? (
                <span className="text-xs text-[#77756F]">
                  {toPersianDigits(itemCount)} قلم
                </span>
              ) : null}
            </div>
            {selectedDetail && activeItems.length > 0 ? (
              <ul className="space-y-2">
                {activeItems.slice(0, 5).map((item) => {
                  const addOns = addOnsByItem.get(item.id) ?? [];
                  const breakdown = linePriceBreakdown({
                    unitPrice: Number(item.unit_price),
                    modifierDeltas: addOns.map((addOn) => addOn.priceDelta),
                    quantity: item.quantity,
                  });
                  return (
                    <li
                      key={item.id}
                      className={
                        "rounded-xl border p-2.5 text-sm " +
                        (addOns.length > 0
                          ? "border-[#F2D097] bg-[#FFFCF5]"
                          : "border-[#EAE8E2] bg-[#FCFCFA]")
                      }
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-bold text-[#252522]">
                            {item.name_snapshot}
                            <span className="ms-1 text-xs font-semibold text-[#77756F]">
                              × {toPersianDigits(item.quantity)}
                            </span>
                          </p>
                          <p className="mt-0.5 text-[11px] text-[#77756F]">
                            {money.format(breakdown.unit)} هر واحد
                          </p>
                        </div>
                        <span className="shrink-0 text-xs font-bold text-[#B97905]">
                          {money.format(breakdown.total)}
                        </span>
                      </div>
                      <ModifierBadges
                        modifiers={addOns}
                        tone="amber"
                        className="mt-2"
                      />
                      {item.note ? (
                        <p className="mt-2 line-clamp-2 text-[11px] text-[#77756F]">
                          یادداشت: {item.note}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
                {activeItems.length > 5 ? (
                  <li className="text-xs text-[#77756F]">
                    و {toPersianDigits(activeItems.length - 5)} قلم دیگر
                  </li>
                ) : null}
              </ul>
            ) : selectedDetail ? (
              <p className="text-xs leading-6 text-[#77756F]">
                قلم فعالی برای این سفارش ثبت نشده است.
              </p>
            ) : (
              <p className="text-xs leading-6 text-[#77756F]">
                خلاصهٔ سفارش آماده است؛ اقلام و عملیات کامل در صفحهٔ جزئیات در
                دسترس‌اند.
              </p>
            )}
          </section>

          <div className="pt-4 md:sticky md:bottom-0 md:-mx-4 md:-mb-4 md:border-t md:border-[#EAE8E2] md:bg-white md:px-4 md:pb-4">
            <p className="mb-3 text-xs text-[#77756F]">
              {closed && order.closed_at
                ? `${order.status === "voided" ? "باطل‌شده" : "بسته‌شده"} در ${orderDateLabel(order.closed_at)}، ساعت ${orderTimeLabel(order.closed_at)}`
                : elapsed
                  ? `از زمان ثبت: ${elapsed}`
                  : `ثبت‌شده در ${orderDateLabel(order.opened_at)}`}
            </p>
            <button
              type="button"
              onClick={() => onOpenDetail(order.id)}
              className="flex min-h-12 w-full items-center justify-center rounded-xl bg-[#E9A11B] px-4 text-sm font-bold text-[#252522] transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] xl:min-h-[52px] motion-reduce:transition-none"
            >
              {/* A closed order can still be corrected — editing or removing it
                  reverses its accounting — and the detail dialog is where that
                  lives, so the label says so rather than promising only "track". */}
              {closed ? "جزئیات و اصلاح سفارش" : "جزئیات و پیگیری سفارش"}
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

export function OrdersList({
  canEdit,
  canAmendClosed = false,
  canBackdate = false,
  initialOrderId = null,
}: {
  /** May work an open order — add lines, discount it, take payment. */
  canEdit: boolean;
  /** May edit or remove an order that has already been paid for. */
  canAmendClosed?: boolean;
  /** May record a sale that already happened — see backdated-order-panel.tsx. */
  canBackdate?: boolean;
  /** `?order=<id>` from the URL: the dialog opens on it once, on first render. */
  initialOrderId?: string | null;
}) {
  /**
   * The back-dating form is a panel on this screen rather than a page of its
   * own: it is the same subject (this branch's sales), reached from the same
   * place, and closed again the moment the paper receipts are typed in.
   */
  const money = useMoney();
  const [showBackdated, setShowBackdated] = useState(false);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [closedOrders, setClosedOrders] = useState<OrderRow[]>([]);
  /** null = nobody is clocked in, so the closed list covers the business day instead of a shift. */
  const [shiftStartedAt, setShiftStartedAt] = useState<string | null>(null);
  /**
   * The branch's trading day (روز کاری), when it has one configured. It, not the
   * calendar day, is then what "the current window" means here: a service running
   * 18:00→03:00 keeps one list across midnight, and the list only goes back to
   * empty when the next business day starts — or the moment management closes
   * the day by hand.
   */
  const [businessDay, setBusinessDay] = useState<BusinessDayWindow | null>(null);
  /** Empty for roles that may not review other people's shifts — the picker hides itself. */
  const [shifts, setShifts] = useState<ShiftOption[]>([]);
  /** "" = the default window (this shift, or today). Otherwise the shift being reviewed. */
  const [shiftFilter, setShiftFilter] = useState("");
  const [initialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(initialOrderId);
  /** The order whose dialog is open — independent of which row is highlighted. */
  const [detailOrderId, setDetailOrderId] = useState<string | null>(initialOrderId);
  const [detailOpen, setDetailOpen] = useState(Boolean(initialOrderId));
  const [detail, setDetail] = useState<OrderDetailsResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [detailRefreshToken, setDetailRefreshToken] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<OrderStatus | "all">("all");
  const [typeFilter, setTypeFilter] = useState<OrderType | "all">("all");
  const [tableFilter, setTableFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("");

  const load = useCallback(async () => {
    setIsRefreshing(true);
    setLoadError("");
    try {
      const { ok, data } = await api<{
        orders: OrderRow[];
        closedOrders?: OrderRow[];
        closedSince?: string | null;
        shiftStartedAt?: string | null;
        businessDay?: BusinessDayWindow | null;
        shifts?: ShiftOption[];
        selectedShift?: ShiftOption | null;
        error?: string;
      }>(
        "/api/orders?scope=shift" +
          (shiftFilter ? `&shiftId=${encodeURIComponent(shiftFilter)}` : ""),
      );
      if (ok) {
        setOrders(data.orders);
        setClosedOrders(data.closedOrders ?? []);
        setShiftStartedAt(data.shiftStartedAt ?? null);
        setBusinessDay(data.businessDay ?? null);
        setShifts(data.shifts ?? []);
        // A shift the branch no longer lists (revoked, or another branch's) is
        // answered with the default window — follow the server rather than
        // leaving the picker pointing at something it isn't showing.
        if (shiftFilter && !data.selectedShift) setShiftFilter("");
        setDetailRefreshToken((token) => token + 1);
      } else {
        setLoadError("فهرست سفارش‌ها به‌روز نشد. داده‌های موجود حفظ شده‌اند.");
      }
    } catch {
      setLoadError(
        "ارتباط با سفارش‌ها برقرار نشد. داده‌های موجود حفظ شده‌اند.",
      );
    } finally {
      setInitialLoading(false);
      setIsRefreshing(false);
    }
  }, [shiftFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(
    useCallback(
      (event) => {
        if (
          ["order.created", "order.updated", "order.item_status"].includes(
            event.type,
          )
        )
          void load();
      },
      [load],
    ),
  );

  // The open queue stays on top, newest first as the API returns it; the
  // shift's closed orders follow, newest close first. Statuses are disjoint,
  // so the two lists never carry the same order twice.
  const orderRows = useMemo(
    () => [...(orders ?? []), ...closedOrders],
    [closedOrders, orders],
  );
  const openCount = orders?.length ?? 0;
  const reviewedShift = shiftFilter
    ? (shifts.find((shift) => shift.id === shiftFilter) ?? null)
    : null;
  const availableStatuses = useMemo(
    () => Array.from(new Set(orderRows.map((order) => order.status))),
    [orderRows],
  );
  const tableNames = useMemo(
    () =>
      Array.from(
        new Set(
          orderRows.flatMap((order) =>
            order.table_name ? [order.table_name] : [],
          ),
        ),
      ).sort((a, b) => a.localeCompare(b, "fa")),
    [orderRows],
  );
  const deferredSearchQuery = useDeferredValue(searchQuery);

  // ⚡ Bolt: Use deferred search query to prevent UI blocking on slow text inputs
  const filteredOrders = useMemo(() => {
    const normalizedSearch = deferredSearchQuery.trim().toLocaleLowerCase("fa");
    return orderRows.filter((order) => {
      const matchesStatus =
        statusFilter === "all" || order.status === statusFilter;
      const matchesType = typeFilter === "all" || order.type === typeFilter;
      const matchesTable =
        tableFilter === "all" || order.table_name === tableFilter;
      const matchesDate =
        !dateFilter || orderDateValue(order.opened_at) === dateFilter;
      const searchableText = [
        formatQueueLabel(order.type, order.order_number),
        TYPE_LABELS[order.type],
        order.table_name ?? "",
        order.customer_name ?? "",
        order.customer_phone ?? "",
      ]
        .join(" ")
        .toLocaleLowerCase("fa");
      return (
        matchesStatus &&
        matchesType &&
        matchesTable &&
        matchesDate &&
        (!normalizedSearch || searchableText.includes(normalizedSearch))
      );
    });
  }, [
    dateFilter,
    orderRows,
    deferredSearchQuery,
    statusFilter,
    tableFilter,
    typeFilter,
  ]);

  useEffect(() => {
    setSelectedOrderId((current) => {
      if (current && orderRows.some((order) => order.id === current))
        return current;
      return orderRows[0]?.id ?? null;
    });
  }, [orderRows]);

  useEffect(() => {
    setSelectedOrderId((current) => {
      if (current && filteredOrders.some((order) => order.id === current))
        return current;
      return filteredOrders[0]?.id ?? null;
    });
  }, [filteredOrders]);

  useEffect(() => {
    if (!selectedOrderId) {
      setDetail(null);
      setDetailError("");
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetail((current) =>
      current?.order.id === selectedOrderId ? current : null,
    );
    setDetailError("");
    setDetailLoading(true);
    api<OrderDetailsResponse & { error?: string }>(
      `/api/orders/${selectedOrderId}`,
    )
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (ok) {
          setDetail(data);
        } else {
          setDetailError(
            "جزئیات سفارش در دسترس نیست. می‌توانید دوباره تلاش کنید یا صفحهٔ جزئیات را باز کنید.",
          );
        }
      })
      .catch(() => {
        if (!cancelled)
          setDetailError("ارتباط برای دریافت جزئیات سفارش برقرار نشد.");
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [detailRefreshToken, selectedOrderId]);

  const selectedOrder =
    orderRows.find((order) => order.id === selectedOrderId) ?? null;
  const hasActiveFilters = Boolean(
    searchQuery ||
      statusFilter !== "all" ||
      typeFilter !== "all" ||
      tableFilter !== "all" ||
      dateFilter ||
      shiftFilter,
  );

  /**
   * The open dialog is reflected in `?order=<id>` so the address bar still
   * names what is on screen — refreshing, or sending the link to a colleague,
   * lands on the same order (that is also where /dashboard/orders/[id]
   * redirects to). `history.replaceState` rather than a router push: opening a
   * dialog should not add a step to the back button, and the queue behind it
   * must not re-render mid-service.
   */
  const syncDetailUrl = useCallback((orderId: string | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (orderId) url.searchParams.set("order", orderId);
    else url.searchParams.delete("order");
    window.history.replaceState(null, "", url.toString());
  }, []);

  function openDetail(orderId: string) {
    setSelectedOrderId(orderId);
    setDetailOrderId(orderId);
    setDetailOpen(true);
    syncDetailUrl(orderId);
  }

  function closeDetail() {
    setDetailOpen(false);
    syncDetailUrl(null);
    void load();
  }

  function clearFilters() {
    setSearchQuery("");
    setStatusFilter("all");
    setTypeFilter("all");
    setTableFilter("all");
    setDateFilter("");
    setShiftFilter("");
  }

  return (
    <div className="mx-auto w-full max-w-[1600px]" dir="rtl">
      <header className="mb-3 flex flex-col gap-3 rounded-2xl border border-[#EAE8E2] bg-white p-3 shadow-[0_1px_3px_rgba(37,37,34,0.03)] sm:p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#FFF1D8] text-[#9B6700]">
            <ShoppingBagIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-[#252522]">
              سفارش‌ها
            </h1>
            <p className="mt-0.5 truncate text-xs text-[#77756F]">
              صف سفارش‌های باز و سفارش‌های بسته‌شدهٔ شعبهٔ فعال
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 md:justify-end">
          <span
            className="text-xs text-[#77756F]"
            role="status"
            aria-live="polite"
          >
            {isRefreshing
              ? "در حال به‌روزرسانی…"
              : `${toPersianDigits(openCount)} سفارش باز` +
                (closedOrders.length
                  ? ` · ${toPersianDigits(closedOrders.length)} بسته‌شده`
                  : "")}
          </span>
          {canBackdate && (
            <button
              type="button"
              onClick={() => setShowBackdated((open) => !open)}
              aria-expanded={showBackdated}
              className="flex min-h-12 items-center gap-2 rounded-xl border border-[#EAE8E2] bg-white px-3 text-xs font-bold text-[#5E5B55] transition duration-200 hover:bg-[#FCFCFA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] xl:min-h-[52px] motion-reduce:transition-none"
            >
              {showBackdated ? "بستن فرم گذشته" : "ثبت سفارش گذشته"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void load()}
            disabled={isRefreshing}
            className="flex min-h-12 items-center gap-2 rounded-xl border border-[#EAE8E2] bg-white px-3 text-xs font-bold text-[#5E5B55] transition duration-200 hover:bg-[#FCFCFA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] disabled:opacity-60 xl:min-h-[52px] motion-reduce:transition-none"
            aria-label={
              isRefreshing
                ? "در حال به‌روزرسانی سفارش‌ها"
                : "به‌روزرسانی سفارش‌ها"
            }
          >
            <RefreshCwIcon
              className={`size-4 ${isRefreshing ? "ops-sync-rotate" : ""}`}
              aria-hidden="true"
            />
            <span>به‌روزرسانی</span>
          </button>
        </div>
      </header>

      {canBackdate && showBackdated ? (
        <div className="mb-3">
          <BackdatedOrderPanel />
        </div>
      ) : null}

      {loadError && orders ? (
        <div
          className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-[#E9A11B]/25 bg-[#FFF9EE] px-3 py-2 text-xs text-[#5E5B55]"
          role="status"
        >
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="min-h-11 shrink-0 px-2 font-bold text-[#9B6700] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
          >
            تلاش دوباره
          </button>
        </div>
      ) : null}

      <section
        className="mb-3 rounded-2xl border border-[#EAE8E2] bg-white p-3 shadow-[0_1px_3px_rgba(37,37,34,0.03)]"
        aria-label="جستجو و فیلتر سفارش‌ها"
      >
        <label className="sr-only" htmlFor="orders-search">
          جستجوی شماره، نوع یا میز سفارش
        </label>
        <div className="relative">
          <SearchIcon
            className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-[#77756F]"
            aria-hidden="true"
          />
          <input
            id="orders-search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="min-h-12 w-full rounded-xl border border-[#EAE8E2] bg-[#FCFCFA] py-2 pe-3 ps-10 text-sm text-[#252522] outline-none placeholder:text-[#8D8A82] focus-visible:border-[#E9A11B] focus-visible:ring-2 focus-visible:ring-[#E9A11B]/25"
            placeholder="جستجو در شماره، نوع یا میز سفارش"
          />
        </div>

        <div
          className="mt-3 flex min-h-12 gap-2 overflow-x-auto pb-1"
          aria-label="فیلتر وضعیت سفارش"
        >
          <button
            type="button"
            onClick={() => setStatusFilter("all")}
            className={`min-h-12 shrink-0 rounded-xl border px-3.5 text-sm font-bold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] xl:min-h-[52px] motion-reduce:transition-none ${
              statusFilter === "all"
                ? "border-[#F2D097] bg-[#FFF1D8] text-[#9B6700]"
                : "border-[#EAE8E2] bg-white text-[#5E5B55] hover:bg-[#FCFCFA]"
            }`}
          >
            همه
          </button>
          {availableStatuses.map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`min-h-12 shrink-0 rounded-xl border px-3.5 text-sm font-bold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] xl:min-h-[52px] motion-reduce:transition-none ${
                statusFilter === status
                  ? "border-[#F2D097] bg-[#FFF1D8] text-[#9B6700]"
                  : "border-[#EAE8E2] bg-white text-[#5E5B55] hover:bg-[#FCFCFA]"
              }`}
            >
              {STATUS_LABELS[status]}
            </button>
          ))}
          {(["dine_in", "takeaway", "delivery"] as OrderType[]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() =>
                setTypeFilter((current) => (current === type ? "all" : type))
              }
              className={`min-h-12 shrink-0 rounded-xl border px-3.5 text-sm font-bold transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] xl:min-h-[52px] motion-reduce:transition-none ${
                typeFilter === type
                  ? "border-[#F2D097] bg-[#FFF1D8] text-[#9B6700]"
                  : "border-[#EAE8E2] bg-white text-[#5E5B55] hover:bg-[#FCFCFA]"
              }`}
            >
              {TYPE_LABELS[type]}
            </button>
          ))}
        </div>

        {shifts.length > 0 ? (
          <label className="mt-2 flex min-h-12 min-w-0 items-center gap-2 rounded-xl border border-[#EAE8E2] bg-white px-3 text-xs text-[#77756F] xl:min-h-[52px]">
            <span className="shrink-0">شیفت</span>
            <SearchableSelect
              value={shiftFilter}
              onChange={setShiftFilter}
              className="min-h-10 min-w-0 flex-1 border-0 bg-transparent text-sm text-[#252522] outline-none"
              ariaLabel="مرور سفارش‌های بسته‌شدهٔ یک شیفت"
              options={[
                {
                  value: "",
                  label: businessDay?.enabled
                    ? "روز کاری جاری"
                    : shiftStartedAt
                      ? "شیفت جاری"
                      : "امروز",
                },
                ...shifts.map((shift) => ({
                  value: shift.id,
                  label: shiftOptionLabel(shift),
                })),
              ]}
            />
          </label>
        ) : null}

        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <label className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#EAE8E2] bg-white px-3 text-xs text-[#77756F] xl:min-h-[52px]">
            <span className="shrink-0">میز</span>
            <SearchableSelect
              value={tableFilter}
              onChange={setTableFilter}
              className="min-h-10 min-w-0 flex-1 border-0 bg-transparent text-sm text-[#252522] outline-none"
              ariaLabel="فیلتر میز سفارش"
              options={[
                { value: "all", label: "همهٔ میزها" },
                ...tableNames.map((tableName) => ({ value: tableName, label: tableName })),
              ]}
            />
          </label>
          <div className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#EAE8E2] bg-white px-3 text-xs text-[#77756F] xl:min-h-[52px]">
            <span className="shrink-0">تاریخ</span>
            <div className="min-w-0 flex-1">
              <JalaliDatePicker
                value={dateFilter}
                onChange={setDateFilter}
                placeholder="همهٔ روزها"
                className="min-h-10 w-full min-w-0 bg-transparent text-sm text-[#252522] outline-none"
              />
            </div>
          </div>
          {hasActiveFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="min-h-12 rounded-xl px-3 text-sm font-bold text-[#9B6700] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 xl:min-h-[52px]"
            >
              پاک‌کردن فیلترها
            </button>
          ) : null}
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(19rem,0.9fr)] xl:grid-cols-[minmax(0,1fr)_minmax(22rem,26rem)]">
        <section
          className="min-w-0 overflow-hidden rounded-2xl border border-[#EAE8E2] bg-white shadow-[0_1px_3px_rgba(37,37,34,0.03)]"
          aria-label="فهرست سفارش‌ها"
        >
          <div className="flex items-center justify-between gap-3 border-b border-[#EAE8E2] px-4 py-3">
            <h2 className="text-sm font-bold text-[#252522]">صف سفارش‌ها</h2>
            <span className="text-xs text-[#77756F]">
              {toPersianDigits(filteredOrders.length)} مورد
            </span>
          </div>

          {orders ? (
            <div className="flex items-center gap-2 border-b border-[#EAE8E2] bg-[#FCFCFA] px-4 py-2 text-[11px] text-[#77756F]" role="status">
              <span title="راهنمای بازه سفارش‌ها" className="inline-flex shrink-0" aria-label="راهنمای بازه سفارش‌ها">
                <InfoIcon className="size-4 text-[#9B6700]" aria-hidden="true" />
              </span>
              <span>بازه سفارش‌ها</span>
              <span className="sr-only">
                {reviewedShift
                  ? `سفارش‌های بسته‌شدهٔ شیفت ${reviewedShift.employeeName} نمایش داده می‌شوند؛ صف بازِ بالا لحظه‌ای است.`
                  : businessDay?.enabled
                    ? businessDay.closedBy === "shift"
                      ? `شیفت ساعت ${orderTimeLabel(businessDay.windowStart)} بسته شد.`
                      : businessDay.closedBy === "manual"
                        ? `روز کاری ساعت ${orderTimeLabel(businessDay.windowStart)} بسته شد.`
                        : `سفارش‌های بسته‌شدهٔ روز کاری جاری از ساعت ${orderTimeLabel(businessDay.windowStart)} نمایش داده می‌شوند.`
                    : shiftStartedAt
                      ? `سفارش‌های بسته‌شده از شروع شیفت در ساعت ${orderTimeLabel(shiftStartedAt)} نمایش داده می‌شوند.`
                      : "سفارش‌های بسته‌شدهٔ امروز نمایش داده می‌شوند."}
              </span>
            </div>
          ) : null}

          {initialLoading && !orders ? (
            <OrderRowsSkeleton />
          ) : !orders ? (
            <div
              className="flex min-h-64 flex-col items-center justify-center p-6 text-center"
              role="status"
            >
              <p className="text-sm font-bold text-[#252522]">
                بارگذاری سفارش‌ها ممکن نشد
              </p>
              <p className="mt-2 max-w-72 text-xs leading-6 text-[#77756F]">
                {loadError || "دوباره تلاش کنید."}
              </p>
              <button
                type="button"
                onClick={() => void load()}
                className="mt-4 min-h-12 rounded-xl bg-[#FFF1D8] px-4 text-sm font-bold text-[#9B6700] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
              >
                تلاش دوباره
              </button>
            </div>
          ) : orderRows.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-[#FFF1D8] text-[#9B6700]">
                <ShoppingBagIcon className="size-5" aria-hidden="true" />
              </span>
              <p className="mt-4 text-sm font-bold text-[#252522]">
                سفارشی برای نمایش نیست
              </p>
              <p className="mt-2 max-w-72 text-xs leading-6 text-[#77756F]">
                با ثبت سفارش جدید، این صف به‌صورت خودکار به‌روز می‌شود.
                سفارش‌های بسته‌شده تا پایان روز کاری همین‌جا می‌مانند.
              </p>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center p-6 text-center">
              <SearchIcon
                className="size-6 text-[#B9B6AE]"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-bold text-[#252522]">
                سفارشی با این فیلتر پیدا نشد
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-3 min-h-11 px-3 text-sm font-bold text-[#9B6700] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45"
              >
                پاک‌کردن فیلترها
              </button>
            </div>
          ) : (
            <div className="divide-y divide-[#EAE8E2]">
              {filteredOrders.map((order) => {
                const isSelected = order.id === selectedOrderId;
                const closed = isClosed(order);
                const elapsed = closed ? null : elapsedLabel(order.opened_at);
                const closedLabel =
                  closed && order.closed_at
                    ? `${order.status === "voided" ? "ابطال" : "تسویه"} ${orderTimeLabel(order.closed_at)}`
                    : null;
                return (
                  <button
                    key={order.id}
                    type="button"
                    /*
                      One tap, one order. Selecting the row used to only fill the
                      summary panel, and reaching the order itself — its lines,
                      its payment, its corrections — meant finding the panel's
                      button afterwards. The card is the order, so it opens it;
                      the panel keeps showing whatever was opened last, which is
                      what it is still good for once the dialog is dismissed.
                    */
                    onClick={() => openDetail(order.id)}
                    aria-pressed={isSelected}
                    aria-haspopup="dialog"
                    className={`flex min-h-[76px] w-full items-center justify-between gap-3 px-4 py-3 text-start transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E9A11B]/45 active:scale-[0.995] md:min-h-[82px] xl:min-h-[88px] motion-reduce:transition-none ${
                      isSelected
                        ? "bg-[#FFF9EE]"
                        : "bg-white hover:bg-[#FCFCFA]"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-[#252522]">
                          {toPersianDigits(
                            formatQueueLabel(order.type, order.order_number),
                          )}
                        </span>
                        <span
                          className={`inline-flex min-h-7 items-center rounded-lg px-2 text-[11px] font-bold ${statusBadgeClass(order.status)}`}
                        >
                          {STATUS_LABELS[order.status]}
                        </span>
                      </div>
                      {/* The customer gets its own line rather than a slot on
                          the muted meta line below: "whose order is this" is
                          read at a glance off this list, and a name folded in
                          among the type, table and timings is not. */}
                      {order.customer_name ? (
                        <p className="mt-1 flex items-center gap-1 text-sm font-bold text-[#252522]">
                          <UserIcon
                            className="size-3.5 shrink-0 text-[#9B6700]"
                            aria-hidden="true"
                          />
                          <span className="truncate">{order.customer_name}</span>
                        </p>
                      ) : null}
                      <p className="mt-1 truncate text-xs text-[#77756F]">
                        {TYPE_LABELS[order.type]}
                        {order.table_name ? ` · ${order.table_name}` : ""}
                        {elapsed ? ` · ${elapsed}` : ""}
                        {closedLabel ? ` · ${closedLabel}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p
                        className={`text-sm font-bold ${closed ? "text-[#77756F]" : "text-[#B97905]"}`}
                      >
                        {money.format(Number(order.total))}
                      </p>
                      <p className="mt-1 text-[11px] text-[#77756F]">
                        {orderTimeLabel(order.opened_at)}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <OrderDetailsPanel
          selectedOrder={selectedOrder}
          detail={detail}
          isLoading={detailLoading}
          error={detailError}
          onRetry={() => setDetailRefreshToken((token) => token + 1)}
          onOpenDetail={openDetail}
        />
      </div>

      <OrderDetailModal
        orderId={detailOrderId}
        open={detailOpen}
        onOpenChange={(next) => (next ? setDetailOpen(true) : closeDetail())}
        canEdit={canEdit}
        canAmendClosed={canAmendClosed}
        onChanged={() => void load()}
      />
    </div>
  );
}
