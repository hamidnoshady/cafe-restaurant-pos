"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  BarChart3Icon,
  BellIcon,
  Building2Icon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ClipboardListIcon,
  RefreshCwIcon,
  ShoppingCartIcon,
  type LucideIcon,
} from "lucide-react";
import { businessDayHours, formatStartTime } from "@/lib/business-day";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatMoneyText, type MoneyUnit } from "@/lib/money";
import { useMoney } from "@/components/money/money-context";
import { BranchSwitcher } from "./branch-switcher";
import { useRealtime } from "./use-realtime";

type LoadStage = "loading" | "kpis" | "chart" | "orders";
type KitchenStatus = "new" | "preparing" | "ready";

interface OverviewData {
  businessName: string;
  locationName: string;
  timeZone: string;
  generatedAt: string;
  kpis: {
    sales: string;
    orderCount: string;
    averageOrderValue: string;
  };
  hourly: { hour: number; revenue: string }[];
  /**
   * The branch's trading day (روز کاری). Null for a branch that has not
   * configured one — then "today" here means the calendar day, exactly as it
   * always did, and nothing below changes.
   */
  businessDay: {
    enabled: boolean;
    startMinutes: number | null;
    businessDate: string;
    /** "shift" = the cashier cashed up, "manual" = «بستن روز کاری», null = still running. */
    closedBy: "manual" | "shift" | null;
    manuallyClosed: boolean;
  } | null;
  activeOrderCount: number;
  activeOrders: {
    id: string;
    orderNumber: string;
    type: "dine_in" | "takeaway" | "delivery";
    tableName: string | null;
    items: string;
    kitchenStatus: KitchenStatus;
    openedAt: string;
  }[];
}

/** Which of the axis's 24 slots get a printed label. */
const CHART_LABEL_SLOTS = [0, 4, 8, 12, 16, 20, 23];
const SKELETON_BAR_HEIGHTS = [28, 42, 55, 74, 88, 81, 67, 52, 45];

const ORDER_STATUS: Record<KitchenStatus, { label: string; className: string }> = {
  new: {
    label: "جدید",
    className: "border-stone-200/80 bg-stone-100 text-stone-500",
  },
  preparing: {
    label: "در حال آماده‌سازی",
    className: "border-amber-500/25 bg-amber-50 text-amber-700",
  },
  ready: {
    label: "آماده",
    className: "border-emerald-500/25 bg-emerald-50 text-emerald-700",
  },
};

function numberValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: number): string {
  return toPersianDigits(Math.round(value).toLocaleString("en-US"));
}

function formatMoney(value: number, unit: MoneyUnit = "toman"): string {
  try {
    return formatMoneyText(String(Math.round(value)), unit);
  } catch {
    return unit === "rial" ? "۰ ریال" : "۰ تومان";
  }
}

function formatTime(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

function formatChartHour(hour: number): string {
  return toPersianDigits(`${String(hour).padStart(2, "0")}:۰۰`);
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return reduced;
}

function useCountUp(target: number, animate: boolean, reducedMotion: boolean): number {
  const [display, setDisplay] = useState(0);
  const played = useRef(false);

  useEffect(() => {
    if (!animate || reducedMotion || played.current) {
      setDisplay(target);
      return;
    }

    played.current = true;
    const startedAt = performance.now();
    const duration = 420;
    let frame = 0;

    const tick = (now: number) => {
      const progress = Math.min((now - startedAt) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(target * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [animate, reducedMotion, target]);

  return display;
}

function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`ops-skeleton block ${className}`} style={style} />;
}

function KpiCard({
  icon: Icon,
  label,
  hint,
  value,
  money,
  loading,
  animateNumber,
  reducedMotion,
  entryDelay,
  className = "",
}: {
  icon: LucideIcon;
  label: string;
  hint: string;
  value: string;
  money?: boolean;
  loading: boolean;
  animateNumber: boolean;
  reducedMotion: boolean;
  entryDelay: number;
  className?: string;
}) {
  const moneyApi = useMoney();
  const displayed = useCountUp(numberValue(value), animateNumber && !loading, reducedMotion);

  return (
    <article
      className={`ops-card-enter min-h-36 rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.04)] sm:p-5 ${className}`}
      style={{ animationDelay: `${entryDelay}ms` }}
      aria-busy={loading}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-stone-500">{label}</p>
          {loading ? (
            <div className="mt-3 space-y-2">
              <Skeleton className="h-8 w-40 max-w-[76%] rounded-lg" />
              <Skeleton className="h-3 w-20 rounded-full" />
            </div>
          ) : (
            <div className="ops-data-resolve">
              <p className="mt-2 text-[1.65rem] font-bold leading-tight tracking-[-0.03em] text-stone-950 sm:text-2xl">
                {money ? formatMoney(displayed, moneyApi.unit) : formatNumber(displayed)}
              </p>
              <p className="mt-2 text-xs text-stone-500">{hint}</p>
            </div>
          )}
        </div>
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600" aria-hidden="true">
          <Icon className="size-5" strokeWidth={1.8} />
        </span>
      </div>
    </article>
  );
}

function SalesTrendSkeleton() {
  return (
    <div aria-hidden="true" className="h-[222px] rounded-xl border-b border-stone-200/80 px-2 pt-4">
      <div className="flex h-[172px] items-end justify-between gap-2">
        {SKELETON_BAR_HEIGHTS.map((height, index) => (
          <div key={index} className="flex h-full flex-1 items-end">
            <Skeleton
              className="w-full rounded-t-md"
              style={{ height: `${height}%`, animationDelay: `${index * 45}ms` } as CSSProperties}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-between gap-2">
        <Skeleton className="h-3 w-9 rounded-full" />
        <Skeleton className="h-3 w-9 rounded-full" />
        <Skeleton className="h-3 w-9 rounded-full" />
        <Skeleton className="h-3 w-9 rounded-full" />
      </div>
    </div>
  );
}

function SalesTrendChart({
  hourly,
  cumulative,
  reducedMotion,
  startMinutes,
}: {
  hourly: OverviewData["hourly"];
  cumulative: boolean;
  reducedMotion: boolean;
  /** The branch's business-day start, so the axis runs in trading order rather than 00→23. */
  startMinutes: number | null;
}) {
  const moneyApi = useMoney();
  const hours = useMemo(() => businessDayHours(startMinutes), [startMinutes]);
  const values = useMemo(() => {
    const revenueByHour = new Map(hourly.map((point) => [point.hour, numberValue(point.revenue)]));
    let runningTotal = 0;
    return hours.map((hour) => {
      const revenue = revenueByHour.get(hour) ?? 0;
      runningTotal += revenue;
      return { hour, value: cumulative ? runningTotal : revenue };
    });
  }, [cumulative, hourly, hours]);

  const width = 960;
  const height = 180;
  const paddingX = 18;
  const paddingTop = 12;
  const baseline = 164;
  const maximum = Math.max(...values.map((point) => point.value), 1);
  const step = (width - paddingX * 2) / values.length;
  const barWidth = Math.max(6, step - 8);
  const points = values.map((point, index) => {
    const barHeight = Math.max(2, ((baseline - paddingTop) * point.value) / maximum);
    return {
      ...point,
      x: paddingX + index * step + step / 2,
      y: baseline - barHeight,
      height: barHeight,
    };
  });
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
  const labelHours = CHART_LABEL_SLOTS.map((slot) => hours[slot]);

  return (
    <div className="ops-data-resolve pt-3" role="img" aria-label={cumulative ? "روند تجمعی فروش امروز" : "روند ساعتی فروش امروز"}>
      <div className="h-[202px] rounded-xl border-b border-stone-200/80 px-1 pt-1 sm:h-[222px]">
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-[172px] w-full sm:h-[188px]" aria-hidden="true">
          {[44, 84, 124].map((line) => (
            <line key={line} x1={paddingX} x2={width - paddingX} y1={line} y2={line} strokeWidth="1" className="stroke-stone-100" />
          ))}
          {points.map((point, index) => (
            <rect
              key={point.hour}
              x={point.x - barWidth / 2}
              y={point.y}
              width={barWidth}
              height={point.height}
              rx="3"
              className={`fill-amber-200 ${reducedMotion ? "" : "ops-chart-bar"}`}
              style={reducedMotion ? undefined : ({ animationDelay: `${index * 45}ms` } as CSSProperties)}
            />
          ))}
          <path
            d={path}
            fill="none"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="0.006 0.018"
            pathLength="1"
            className={`stroke-amber-600 ${reducedMotion ? "" : "ops-chart-line"}`}
          />
        </svg>
        <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-stone-400 sm:text-xs">
          {labelHours.map((hour) => (
            <span key={hour}>{formatChartHour(hour)}</span>
          ))}
        </div>
      </div>
      <p className="sr-only">
        {cumulative ? "جمع فروش تجمعی" : "فروش ساعتی"}: {formatMoney(values.at(-1)?.value ?? 0, moneyApi.unit)}
      </p>
    </div>
  );
}

function StatusChip({ status }: { status: KitchenStatus }) {
  const detail = ORDER_STATUS[status];
  return <span className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-medium ${detail.className}`}>{detail.label}</span>;
}

function OrdersSkeleton() {
  return (
    <div aria-busy="true" aria-label="در حال آماده‌سازی سفارش‌ها">
      <div className="hidden overflow-hidden rounded-xl border border-stone-200/80 md:block">
        <div className="grid grid-cols-[minmax(5rem,.8fr)_minmax(7rem,1.1fr)_minmax(6rem,1fr)_5.5rem] gap-4 border-b border-stone-200/80 bg-stone-50 px-4 py-3 text-xs text-stone-500 lg:grid-cols-[minmax(6rem,.8fr)_minmax(8rem,1fr)_minmax(15rem,2.4fr)_minmax(7.5rem,1fr)_4.5rem]">
          <span>شماره</span><span>میز / نوع</span><span className="hidden lg:block">اقلام</span><span>وضعیت</span><span>زمان</span>
        </div>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="grid min-h-[70px] grid-cols-[minmax(5rem,.8fr)_minmax(7rem,1.1fr)_minmax(6rem,1fr)_5.5rem] items-center gap-4 border-b border-stone-100 px-4 py-3 last:border-b-0 lg:grid-cols-[minmax(6rem,.8fr)_minmax(8rem,1fr)_minmax(15rem,2.4fr)_minmax(7.5rem,1fr)_4.5rem]">
            <Skeleton className={`h-4 rounded-full ${row % 2 ? "w-12" : "w-16"}`} />
            <Skeleton className={`h-4 rounded-full ${row % 2 ? "w-20" : "w-24"}`} />
            <Skeleton className={`hidden h-4 rounded-full lg:block ${row % 2 ? "w-40" : "w-52"}`} />
            <span className="inline-flex w-fit rounded-full border border-stone-200/80 bg-stone-50 px-2 py-1 text-[11px] text-stone-500">در حال آماده‌سازی</span>
            <Skeleton className="h-4 w-10 rounded-full" />
          </div>
        ))}
      </div>
      <div className="space-y-3 md:hidden">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="rounded-xl border border-stone-200/80 bg-white p-4">
            <div className="flex items-center justify-between gap-3"><Skeleton className="h-5 w-16 rounded-full" /><span className="inline-flex rounded-full border border-stone-200/80 bg-stone-50 px-2 py-1 text-[11px] text-stone-500">در حال آماده‌سازی</span></div>
            <Skeleton className={`mt-4 h-4 rounded-full ${row % 2 ? "w-2/3" : "w-4/5"}`} />
            <div className="mt-4 flex justify-between"><Skeleton className="h-3 w-16 rounded-full" /><Skeleton className="h-3 w-12 rounded-full" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OrdersTable({ orders, timeZone }: { orders: OverviewData["activeOrders"]; timeZone: string }) {
  if (orders.length === 0) {
    return <p className="flex min-h-[320px] items-center justify-center rounded-xl border border-dashed border-stone-200/80 bg-stone-50 px-4 py-8 text-center text-sm text-stone-500 md:min-h-[330px]">در حال حاضر سفارش بازی وجود ندارد.</p>;
  }

  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-stone-200/80 md:block" role="table" aria-label="سفارش‌های باز">
        <div className="grid grid-cols-[minmax(5rem,.8fr)_minmax(7rem,1.1fr)_minmax(6rem,1fr)_5.5rem] gap-4 border-b border-stone-200/80 bg-stone-50 px-4 py-3 text-xs font-medium text-stone-500 lg:grid-cols-[minmax(6rem,.8fr)_minmax(8rem,1fr)_minmax(15rem,2.4fr)_minmax(7.5rem,1fr)_4.5rem]" role="row">
          <span role="columnheader">شماره</span><span role="columnheader">میز / نوع</span><span className="hidden lg:block" role="columnheader">اقلام</span><span role="columnheader">وضعیت</span><span role="columnheader">زمان</span>
        </div>
        {orders.map((order, index) => (
          <Link
            key={order.id}
            href={`/dashboard/orders/${order.id}`}
            className="ops-order-row grid min-h-[70px] grid-cols-[minmax(5rem,.8fr)_minmax(7rem,1.1fr)_minmax(6rem,1fr)_5.5rem] items-center gap-4 border-b border-stone-100 px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.99] lg:grid-cols-[minmax(6rem,.8fr)_minmax(8rem,1fr)_minmax(15rem,2.4fr)_minmax(7.5rem,1fr)_4.5rem]"
            style={{ animationDelay: `${index * 60}ms` }}
            aria-label={`مشاهده سفارش ${toPersianDigits(order.orderNumber)}`}
            role="row"
          >
            <span className="font-semibold text-stone-950" role="cell">#{toPersianDigits(order.orderNumber)}</span>
            <span className="min-w-0 truncate text-stone-500" role="cell">{order.tableName ?? (order.type === "takeaway" ? "بیرون‌بر" : "ارسال")}</span>
            <span className="hidden min-w-0 truncate text-stone-500 lg:block" role="cell">{order.items || "—"}</span>
            <span role="cell"><StatusChip status={order.kitchenStatus} /></span>
            <span className="text-xs tabular-nums text-stone-500" role="cell">{formatTime(order.openedAt, timeZone)}</span>
          </Link>
        ))}
      </div>
      <div className="space-y-3 md:hidden">
        {orders.map((order, index) => (
          <Link
            key={order.id}
            href={`/dashboard/orders/${order.id}`}
            className="ops-order-row block rounded-xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.98]"
            style={{ animationDelay: `${index * 60}ms` }}
            aria-label={`مشاهده سفارش ${toPersianDigits(order.orderNumber)}`}
          >
            <div className="flex items-start justify-between gap-3"><span className="font-semibold text-stone-950">#{toPersianDigits(order.orderNumber)}</span><StatusChip status={order.kitchenStatus} /></div>
            <p className="mt-3 text-sm leading-6 text-stone-950">{order.items || "بدون قلم"}</p>
            <div className="mt-3 flex items-center justify-between border-t border-stone-100 pt-3 text-xs text-stone-500"><span>{order.tableName ?? (order.type === "takeaway" ? "بیرون‌بر" : "ارسال")}</span><span>{formatTime(order.openedAt, timeZone)}</span></div>
          </Link>
        ))}
      </div>
    </>
  );
}

export function OperationsOverview({
  role,
}: {
  role: "owner" | "manager" | "cashier" | "waiter";
}) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [stage, setStage] = useState<LoadStage>("loading");
  const [error, setError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cumulative, setCumulative] = useState(false);
  const [hasResolvedInitialData, setHasResolvedInitialData] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [successTick, setSuccessTick] = useState(0);
  const dataRef = useRef<OverviewData | null>(null);
  const requestInFlight = useRef(false);
  const stageTimers = useRef<number[]>([]);
  const realtimeTimer = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();

  const today = useMemo(() => toPersianDigits(formatJalali(new Date(), { withMonthName: true })), []);

  const clearStageTimers = useCallback(() => {
    stageTimers.current.forEach((timer) => window.clearTimeout(timer));
    stageTimers.current = [];
  }, []);

  const revealDataInOrder = useCallback(() => {
    clearStageTimers();
    setStage("kpis");
    stageTimers.current = [
      window.setTimeout(() => setStage("chart"), reducedMotion ? 0 : 180),
      window.setTimeout(() => setStage("orders"), reducedMotion ? 0 : 380),
    ];
  }, [clearStageTimers, reducedMotion]);

  const load = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    const backgroundRefresh = dataRef.current !== null;
    if (backgroundRefresh) {
      setIsRefreshing(true);
      setRefreshTick((value) => value + 1);
    }
    setError("");

    try {
      const response = await fetch("/api/dashboard/overview", { cache: "no-store" });
      if (!response.ok) throw new Error("overview_failed");
      const next = (await response.json()) as OverviewData;
      const isInitial = dataRef.current === null;
      dataRef.current = next;
      setData(next);
      setSuccessTick((value) => value + 1);

      if (isInitial) {
        setHasResolvedInitialData(true);
        revealDataInOrder();
      }
    } catch {
      setError(backgroundRefresh ? "به‌روزرسانی انجام نشد؛ داده‌های آخر نمایش داده می‌شود." : "دریافت نمای امروز انجام نشد.");
    } finally {
      requestInFlight.current = false;
      setIsRefreshing(false);
    }
  }, [revealDataInOrder]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 60_000);
    return () => {
      window.clearInterval(interval);
      clearStageTimers();
      if (realtimeTimer.current !== null) window.clearTimeout(realtimeTimer.current);
    };
  }, [clearStageTimers, load]);

  useRealtime(
    useCallback(
      (event) => {
        if (!["order.created", "order.updated", "order.item_status"].includes(event.type)) return;
        if (realtimeTimer.current !== null) window.clearTimeout(realtimeTimer.current);
        realtimeTimer.current = window.setTimeout(() => void load(), 360);
      },
      [load],
    ),
  );

  const showKpis = data !== null && stage !== "loading";
  const showChart = data !== null && (stage === "chart" || stage === "orders");
  const showOrders = data !== null && stage === "orders";
  const syncLabel = data === null ? "در حال دریافت داده‌ها" : isRefreshing ? "داده‌ها در حال به‌روزرسانی است" : "به‌روزرسانی شد";
  const roleLabel = role === "manager" ? "مدیر شیفت" : role === "owner" ? "مالک" : role === "cashier" ? "صندوقدار" : "گارسون";
  // With a business day configured the heading has to name *that* day: at 01:00
  // on an 18:00→18:00 day these figures are still the previous date's service,
  // and printing today's calendar date over them is the confusion the whole
  // feature exists to remove.
  const businessDay = data?.businessDay ?? null;
  const dayLabel =
    businessDay?.enabled && businessDay.businessDate
      ? toPersianDigits(formatJalali(businessDay.businessDate, { withMonthName: true }))
      : today;
  const businessDayNote =
    businessDay?.enabled && businessDay.startMinutes !== null
      ? `روز کاری از ساعت ${toPersianDigits(formatStartTime(businessDay.startMinutes))}` +
        (businessDay.closedBy === "shift"
          ? " · شیفت بسته شده"
          : businessDay.closedBy === "manual"
            ? " · بسته‌شده"
            : "")
      : null;

  return (
    <section className="w-full" aria-labelledby="operations-heading">
      <h1 id="operations-heading" className="sr-only">نمای کلی عملیات امروز</h1>
      <header className="mb-5 hidden items-start justify-between gap-4 rounded-2xl border border-stone-200/80 bg-white px-5 py-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)] md:flex">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-2xl font-bold tracking-[-0.03em] text-stone-950">نمای کلی عملیات امروز</p>
            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-medium text-stone-500">{roleLabel}</span>
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-sm text-stone-500"><CalendarDaysIcon className="size-4" aria-hidden="true" />{dayLabel}{businessDayNote ? <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-500">{businessDayNote}</span> : null}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex min-h-11 items-center gap-2 rounded-xl border border-stone-200/80 bg-stone-50 px-3 text-sm font-medium text-stone-950">
            <Building2Icon className="size-4 text-amber-600" aria-hidden="true" />
            <span className="max-w-36 truncate">{data?.businessName ?? "کسب‌وکار"}</span>
          </div>
          <BranchSwitcher compact />
          <Link href="/dashboard/orders" className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-stone-200/80 bg-white text-stone-600 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.98]" aria-label="مشاهده سفارش‌های باز">
            <BellIcon className="size-5" aria-hidden="true" />
            {data && data.activeOrderCount > 0 ? <span className="absolute -left-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-amber-100 px-1 text-[10px] font-bold leading-5 text-amber-700">{toPersianDigits(String(data.activeOrderCount))}</span> : null}
          </Link>
          <div className="flex min-h-11 items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-3 text-xs text-emerald-700" role="status">
            {/* Both keys only force a remount so the animation replays. They must stay
                namespaced: the two counters are equal on mount and again on every refresh
                (refreshTick bumps before the fetch, successTick after), and bare numbers
                made these two siblings collide on every poll. */}
            <RefreshCwIcon key={`sync-${refreshTick}`} className={`size-4 ${refreshTick > 0 && !reducedMotion ? "ops-sync-rotate" : ""}`} aria-hidden="true" />
            <span key={`ok-${successTick}`} className={`flex size-2 rounded-full bg-emerald-500 ${successTick > 0 && !reducedMotion ? "ops-sync-pulse" : ""}`} aria-hidden="true" />
            <span>{syncLabel}</span>
            {data && !isRefreshing ? <span className="border-r border-emerald-200 pr-2 tabular-nums">{formatTime(data.generatedAt, data.timeZone)}</span> : null}
          </div>
        </div>
      </header>

      <div className="mb-5 grid gap-3 md:grid-cols-3 md:gap-4">
        <KpiCard icon={BarChart3Icon} label="فروش امروز" hint="جمع فروش تکمیل‌شده" value={data?.kpis.sales ?? "0"} money loading={!showKpis} animateNumber={hasResolvedInitialData} reducedMotion={reducedMotion} entryDelay={0} className="md:hidden" />
        <div className="hidden md:contents">
          <KpiCard icon={BarChart3Icon} label="فروش امروز" hint="جمع فروش تکمیل‌شده" value={data?.kpis.sales ?? "0"} money loading={!showKpis} animateNumber={hasResolvedInitialData} reducedMotion={reducedMotion} entryDelay={0} />
          <KpiCard icon={ClipboardListIcon} label="تعداد سفارش" hint="سفارش‌های تکمیل‌شده" value={data?.kpis.orderCount ?? "0"} loading={!showKpis} animateNumber={hasResolvedInitialData} reducedMotion={reducedMotion} entryDelay={60} />
          <KpiCard icon={ShoppingCartIcon} label="میانگین سفارش" hint="میانگین هر فاکتور" value={data?.kpis.averageOrderValue ?? "0"} money loading={!showKpis} animateNumber={hasResolvedInitialData} reducedMotion={reducedMotion} entryDelay={120} />
        </div>
      </div>

      <div className="-mx-4 mb-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 md:hidden" aria-label="شاخص‌های تکمیلی">
        <KpiCard icon={ClipboardListIcon} label="تعداد سفارش" hint="سفارش‌های تکمیل‌شده" value={data?.kpis.orderCount ?? "0"} loading={!showKpis} animateNumber={hasResolvedInitialData} reducedMotion={reducedMotion} entryDelay={60} className="min-w-[calc(100%-48px)] snap-start" />
        <KpiCard icon={ShoppingCartIcon} label="میانگین سفارش" hint="میانگین هر فاکتور" value={data?.kpis.averageOrderValue ?? "0"} money loading={!showKpis} animateNumber={hasResolvedInitialData} reducedMotion={reducedMotion} entryDelay={120} className="min-w-[calc(100%-48px)] snap-start" />
      </div>

      <section className="mb-5 overflow-hidden rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)] sm:p-5" aria-labelledby="sales-trend-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><h2 id="sales-trend-heading" className="font-semibold text-stone-950">روند فروش امروز</h2><p className="mt-1 text-xs text-stone-500">فروش‌های تکمیل‌شده به تفکیک ساعت{businessDayNote ? ` — ${businessDayNote}` : ""}</p></div>
          <div className="inline-flex min-h-11 w-fit rounded-xl border border-stone-200/80 bg-stone-50 p-1" role="group" aria-label="نمایش روند فروش">
            <button type="button" onClick={() => setCumulative(false)} aria-pressed={!cumulative} className={`min-h-9 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.98] ${!cumulative ? "bg-white text-stone-950 shadow-[0_1px_2px_rgba(37,37,34,0.05)]" : "text-stone-500"}`}>ساعتی</button>
            <button type="button" onClick={() => setCumulative(true)} aria-pressed={cumulative} className={`min-h-9 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.98] ${cumulative ? "bg-white text-stone-950 shadow-[0_1px_2px_rgba(37,37,34,0.05)]" : "text-stone-500"}`}>تجمعی</button>
          </div>
        </div>
        {showChart ? <SalesTrendChart key={cumulative ? "cumulative" : "hourly"} hourly={data.hourly} cumulative={cumulative} reducedMotion={reducedMotion} startMinutes={data.businessDay?.enabled ? data.businessDay.startMinutes : null} /> : <SalesTrendSkeleton />}
      </section>

      <section className="rounded-2xl border border-stone-200/80 bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)] sm:p-5" aria-labelledby="active-orders-heading">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div><h2 id="active-orders-heading" className="font-semibold text-stone-950">سفارش‌های فعال</h2><p className="mt-1 text-xs text-stone-500">وضعیت سفارش‌های باز همین شعبه</p></div>
          <Link href="/dashboard/orders" className="hidden min-h-11 items-center gap-1 rounded-xl border border-stone-200/80 px-3 text-sm font-medium text-stone-950 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.98] sm:inline-flex">مشاهده همه<ChevronLeftIcon className="size-4" aria-hidden="true" /></Link>
        </div>
        {showOrders ? <OrdersTable orders={data.activeOrders} timeZone={data.timeZone} /> : <OrdersSkeleton />}
        <Link href="/dashboard/orders" className="mt-4 flex min-h-12 w-full items-center justify-center gap-1 rounded-xl border border-amber-500/35 bg-amber-50 px-4 text-sm font-semibold text-amber-800 transition-colors hover:bg-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.98] sm:hidden">مشاهده همه سفارش‌ها<ChevronLeftIcon className="size-4" aria-hidden="true" /></Link>
      </section>

      {error ? (
        <div className="mt-4 flex flex-col gap-3 rounded-xl border border-destructive/20 bg-destructive/[0.035] px-4 py-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between" role="status">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="min-h-11 rounded-lg border border-destructive/25 bg-white px-3 text-sm font-medium text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/35 active:scale-[0.98]">تلاش دوباره</button>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">{syncLabel}</p>
    </section>
  );
}
