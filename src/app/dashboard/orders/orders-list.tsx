"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, useDeferredValue } from "react";
import { RefreshCwIcon, SearchIcon, ShoppingBagIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { formatQueueLabel } from "@/lib/orders";
import {
  linePriceBreakdown,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import { useRealtime } from "../use-realtime";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api } from "../ui";

type OrderStatus = "open" | "held" | "completed" | "voided";
type OrderType = "dine_in" | "takeaway" | "delivery";

interface OpenOrder {
  id: string;
  order_number: number;
  type: OrderType;
  status: OrderStatus;
  table_name: string | null;
  guest_count: number | null;
  total: string | number;
  opened_at: string;
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

interface DetailedOrder extends OpenOrder {
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

const TYPE_LABELS: Record<OrderType, string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
};

function orderDateValue(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
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
}: {
  selectedOrder: OpenOrder | null;
  detail: OrderDetailsResponse | null;
  isLoading: boolean;
  error: string;
  onRetry: () => void;
}) {
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
  const elapsed = elapsedLabel(order.opened_at);

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
        <span className="inline-flex min-h-8 shrink-0 items-center rounded-lg bg-[#FFF1D8] px-2.5 text-xs font-bold text-[#9B6700]">
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
                {formatToman(Number(order.total))}
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
            <div className="rounded-xl bg-[#FCFCFA] p-3">
              <dt className="text-[11px] text-[#77756F]">زمان ثبت</dt>
              <dd className="mt-1 text-sm font-bold text-[#252522]">
                {orderTimeLabel(order.opened_at)}
              </dd>
            </div>
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
                            {formatToman(breakdown.unit)} هر واحد
                          </p>
                        </div>
                        <span className="shrink-0 text-xs font-bold text-[#B97905]">
                          {formatToman(breakdown.total)}
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
              {elapsed
                ? `از زمان ثبت: ${elapsed}`
                : `ثبت‌شده در ${orderDateLabel(order.opened_at)}`}
            </p>
            <Link
              href={`/dashboard/orders/${order.id}`}
              className="flex min-h-12 w-full items-center justify-center rounded-xl bg-[#E9A11B] px-4 text-sm font-bold text-[#252522] transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 active:scale-[0.98] xl:min-h-[52px] motion-reduce:transition-none"
            >
              جزئیات و پیگیری سفارش
            </Link>
          </div>
        </>
      )}
    </aside>
  );
}

export function OrdersList() {
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
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
      const { ok, data } = await api<{ orders: OpenOrder[]; error?: string }>(
        "/api/orders",
      );
      if (ok) {
        setOrders(data.orders);
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
  }, []);

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

  const orderRows = orders ?? [];
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
      dateFilter,
  );

  function clearFilters() {
    setSearchQuery("");
    setStatusFilter("all");
    setTypeFilter("all");
    setTableFilter("all");
    setDateFilter("");
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
              صف پیگیری سفارش‌های بازِ شعبهٔ فعال
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
              : `${toPersianDigits(orderRows.length)} سفارش باز`}
          </span>
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
          <label className="flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border border-[#EAE8E2] bg-white px-3 text-xs text-[#77756F] xl:min-h-[52px]">
            <span className="shrink-0">تاریخ</span>
            <input
              type="date"
              value={dateFilter}
              onChange={(event) => setDateFilter(event.target.value)}
              className="min-h-10 min-w-0 flex-1 bg-transparent text-sm text-[#252522] outline-none"
              dir="ltr"
              aria-label="فیلتر تاریخ ثبت سفارش"
            />
          </label>
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
                سفارش بازی وجود ندارد
              </p>
              <p className="mt-2 max-w-72 text-xs leading-6 text-[#77756F]">
                با ثبت سفارش جدید، این صف به‌صورت خودکار به‌روز می‌شود.
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
                const elapsed = elapsedLabel(order.opened_at);
                return (
                  <button
                    key={order.id}
                    type="button"
                    onClick={() => setSelectedOrderId(order.id)}
                    aria-pressed={isSelected}
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
                        <span className="inline-flex min-h-7 items-center rounded-lg bg-[#FFF1D8] px-2 text-[11px] font-bold text-[#9B6700]">
                          {STATUS_LABELS[order.status]}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs text-[#77756F]">
                        {TYPE_LABELS[order.type]}
                        {order.table_name ? ` · ${order.table_name}` : ""}
                        {elapsed ? ` · ${elapsed}` : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-end">
                      <p className="text-sm font-bold text-[#B97905]">
                        {formatToman(Number(order.total))}
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
        />
      </div>
    </div>
  );
}
