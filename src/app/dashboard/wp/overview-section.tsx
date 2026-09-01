"use client";

/**
 * The WP Manager میز کار: connection picker, sync watermarks, KPI tiles for
 * the mirrored catalogue/orders/customers/content, and quick actions
 * (همگام‌سازی) per connection. All numbers come from local mirrors so the
 * page behaves identically in plugin and REST link modes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  PlugIcon,
  ShoppingBagIcon,
  ReceiptTextIcon,
  ContactIcon,
  FolderTreeIcon,
  FileTextIcon,
  ImageIcon,
  RefreshCwIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { api } from "../ui";
import { cardClass, EmptyState, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { WpOverviewStats } from "@/lib/integrations/wp-manager-service";

interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  linkMode: "rest_api" | "plugin";
  status: "active" | "paused" | "error";
  currencyUnit: string;
  syncOrders: boolean;
  syncProducts: boolean;
  syncCustomers: boolean;
  lastSyncAt: string | null;
  lastCatalogueSyncAt: string | null;
  lastOrderSyncAt: string | null;
  lastCustomerSyncAt?: string | null;
  lastPluginSeenAt: string | null;
  lastError: string | null;
  pluginVersion: string | null;
}

function syncNow(connectionId: string, kind: "products" | "orders" | "customers" | "content" | "inventory") {
  if (kind === "content") {
    return api(`/api/integrations/wp-manager/content`, {
      method: "POST",
      body: JSON.stringify({ connectionId, action: "sync" }),
    });
  }
  return api(`/api/integrations/connections/${connectionId}/sync/${kind}`, { method: "POST" });
}

function Kpi({
  icon: Icon,
  label,
  value,
  href,
  tone = "default",
}: {
  icon: typeof PlugIcon;
  label: string;
  value: number | string;
  href?: string;
  tone?: "default" | "warn";
}) {
  const body = (
    <div className={`${cardClass} flex items-center gap-3 p-4 transition-colors hover:bg-stone-50 dark:hover:bg-stone-900/40 sm:p-5`}>
      <span
        className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${
          tone === "warn" ? "bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300" : "bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300"
        }`}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-bold tabular-nums text-foreground">{toPersianDigits(value)}</p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

function SyncRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground/80">{value ? formatJalali(value, { withTime: true }) : "—"}</span>
    </div>
  );
}

export function WpOverviewSection() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [stats, setStats] = useState<WpOverviewStats | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [connRes, statsRes] = await Promise.all([
      api<{ connections: Connection[] }>("/api/integrations/connections?provider=woocommerce"),
      api<{ stats: WpOverviewStats }>("/api/integrations/wp-manager/overview"),
    ]);
    if (connRes.ok) {
      setConnections(connRes.data.connections);
      setSelectedId((current) => current || connRes.data.connections[0]?.id || "");
    }
    if (statsRes.ok) setStats(statsRes.data.stats);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => connections?.find((c) => c.id === selectedId) ?? connections?.[0] ?? null,
    [connections, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    api<{ stats: WpOverviewStats }>(`/api/integrations/wp-manager/overview?connectionId=${selected.id}`).then((res) => {
      if (res.ok) setStats(res.data.stats);
    });
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runSync(kind: "products" | "orders" | "customers" | "content") {
    if (!selected) return;
    setBusy(kind);
    setError("");
    const res = await syncNow(selected.id, kind);
    setBusy("");
    if (!res.ok) setError(res.data?.error ? String(res.data.error) : "همگام‌سازی با خطا مواجه شد");
    setTimeout(load, 400);
  }

  if (connections === null) {
    return <SectionCardSkeleton rows={6} />;
  }

  if (connections.length === 0) {
    return (
      <EmptyState>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <PlugIcon className="size-10 text-muted-foreground/60" />
          <p className="font-semibold text-foreground">هنوز فروشگاهی متصل نیست</p>
          <p className="max-w-md text-sm text-muted-foreground">
            برای مدیریت وردپرس و ووکامرس از اینجا، ابتدا فروشگاه خود را با کلیدهای REST یا افزونهٔ وردپرس متصل کنید.
          </p>
          <Link href="/dashboard/wp/connections">
            <Button>اتصال فروشگاه</Button>
          </Link>
        </div>
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* Connection picker */}
      <div className={`${cardClass} p-4 sm:p-5`}>
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="min-w-[14rem] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground focus-visible:border-teal-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/30"
            value={selected?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            aria-label="انتخاب فروشگاه"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.linkMode === "plugin" ? "افزونهٔ وردپرس" : "REST API"}
              </option>
            ))}
          </select>
          {selected ? (
            <StatusBadge tone={selected.status === "active" ? "positive" : selected.status === "error" ? "danger" : "neutral"}>
              {selected.status === "active" ? "فعال" : selected.status === "error" ? "خطا" : "متوقف"}
            </StatusBadge>
          ) : null}
          <span className="text-xs text-muted-foreground">
            {selected?.linkMode === "plugin"
              ? selected.pluginVersion
                ? `افزونه نسخهٔ ${toPersianDigits(selected.pluginVersion)}`
                : "حالت افزونه"
              : "حالت REST API"}
          </span>
          <div className="ms-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => runSync("products")}>
              <RefreshCwIcon className="size-4" />
              همگام‌سازی محصولات
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => runSync("orders")}>
              <RefreshCwIcon className="size-4" />
              همگام‌سازی سفارش‌ها
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => runSync("customers")}>
              <RefreshCwIcon className="size-4" />
              همگام‌سازی مشتریان
            </Button>
            <Button variant="outline" size="sm" disabled={busy !== ""} onClick={() => runSync("content")}>
              <RefreshCwIcon className="size-4" />
              همگام‌سازی محتوا
            </Button>
          </div>
        </div>
        {error ? <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
        {selected?.lastError ? (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            آخرین خطا: {selected.lastError}
          </p>
        ) : null}
        <div className="mt-3 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-4">
          <SyncRow label="آخرین ارتباط کلی" value={selected?.lastSyncAt ?? null} />
          <SyncRow label="آخرین همگام‌سازی کاتالوگ" value={selected?.lastCatalogueSyncAt ?? null} />
          <SyncRow label="آخرین همگام‌سازی سفارش‌ها" value={selected?.lastOrderSyncAt ?? null} />
          <SyncRow
            label="آخرین مشاهدهٔ افزونه"
            value={selected?.linkMode === "plugin" ? selected?.lastPluginSeenAt ?? null : null}
          />
        </div>
      </div>

      {/* KPI tiles */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi icon={ShoppingBagIcon} label="محصول همگام‌شده" value={stats?.products ?? 0} href="/dashboard/wp/products" />
        <Kpi icon={ReceiptTextIcon} label="سفارش آنلاین" value={stats?.orders ?? 0} href="/dashboard/wp/orders" />
        <Kpi icon={ContactIcon} label="مشتری فروشگاه" value={stats?.customers ?? 0} href="/dashboard/wp/customers" />
        <Kpi icon={FolderTreeIcon} label="دسته/برچسب/ویژگی" value={stats?.terms ?? 0} href="/dashboard/wp/taxonomies" />
        <Kpi icon={FileTextIcon} label="نوشته و برگه" value={(stats?.content.posts ?? 0) + (stats?.content.pages ?? 0)} href="/dashboard/wp/content" />
        <Kpi icon={ImageIcon} label="رسانه" value={stats?.content.media ?? 0} href="/dashboard/wp/media" />
        <Kpi
          icon={RefreshCwIcon}
          label="کار در صف"
          value={stats?.pendingJobs ?? 0}
          href="/dashboard/wp/queue"
        />
        <Kpi
          icon={AlertTriangleIcon}
          label="رویداد ناموفق"
          value={(stats?.failedJobs ?? 0) + (stats?.deadJobs ?? 0) + (stats?.failedInboxEvents ?? 0)}
          tone={(stats?.failedJobs ?? 0) + (stats?.deadJobs ?? 0) + (stats?.failedInboxEvents ?? 0) > 0 ? "warn" : "default"}
          href="/dashboard/wp/queue"
        />
      </div>
    </div>
  );
}
