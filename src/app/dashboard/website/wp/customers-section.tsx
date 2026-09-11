"use client";

/**
 * The store's mirrored customer book: who the customers are on the store
 * side, joined to the local CRM record. Reads /api/integrations/wp-manager/
 * customers; the sync itself is the catalogue button (plugin: queued
 * customer_export job; REST: direct pull).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ContactIcon, RefreshCwIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/app/dashboard/ui";
import { cardClass, EmptyState, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ConnectionPicker, type ConnectionLite } from "./connection-lite";
import { crmCustomerHref } from "@/app/dashboard/crm/crm-routes";
import { PluginWaitNote } from "./plugin-wait-note";

interface StoreCustomer {
  remoteId: string;
  localId: string;
  name: string;
  phone: string | null;
  email: string | null;
  ordersCount: number;
  lastSeen: string | null;
}

export function WpCustomersSection() {
  const [connections, setConnections] = useState<ConnectionLite[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [customers, setCustomers] = useState<StoreCustomer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");

  useEffect(() => {
    api<{ connections: ConnectionLite[] }>("/api/integrations/connections?provider=woocommerce").then((res) => {
      if (res.ok) {
        setConnections(res.data.connections);
        setSelectedId(res.data.connections[0]?.id ?? "");
      } else setConnections([]);
    });
  }, []);

  const load = useCallback((connectionId: string) => {
    setCustomers(null);
    api<{ customers: StoreCustomer[] }>(`/api/integrations/wp-manager/customers?connectionId=${connectionId}`).then(
      (res) => {
        if (res.ok) setCustomers(res.data.customers);
        else setCustomers([]);
      },
    );
  }, []);

  useEffect(() => {
    if (selectedId) load(selectedId);
  }, [selectedId, load]);

  async function syncCustomers() {
    if (!selectedId) return;
    setBusy(true);
    setInfo("");
    const res = await api(`/api/integrations/connections/${selectedId}/sync/customers`, { method: "POST" });
    setBusy(false);
    if (!res.ok) {
      setInfo(String(res.data?.error ?? "همگام‌سازی با خطا مواجه شد"));
    } else {
      setInfo(res.data?.queued ? "درخواست همگام‌سازی در صف قرار گرفت؛ با اجرای بعدی افزونه مشتریان می‌رسند." : "همگام‌سازی انجام شد.");
      setTimeout(() => load(selectedId), 3000);
    }
  }

  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0) {
    return <EmptyState>فروشگاهی متصل نیست.</EmptyState>;
  }

  return (
    <div className="space-y-4">
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        <ConnectionPicker connections={connections} value={selectedId} onChange={setSelectedId} />
        <Button variant="outline" size="sm" disabled={busy} onClick={syncCustomers} className="ms-auto">
          <RefreshCwIcon className="size-4" />
          همگام‌سازی مشتریان
        </Button>
      </div>
      <PluginWaitNote connections={connections} selectedId={selectedId} />
      {info ? <p className="text-xs text-teal-700 dark:text-teal-300">{info}</p> : null}

      <section className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 className="font-semibold text-foreground">مشتریان همگام‌شده</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {customers === null
              ? "در حال بارگیری…"
              : toPersianDigits(customers.length) + " مشتری از فروشگاه به پروندهٔ مشتریان سیستم متصل است."}
          </p>
        </div>
        {customers === null ? (
          <SectionCardSkeleton rows={4} />
        ) : customers.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
            هنوز مشتری‌ای از فروشگاه همگام نشده است. «همگام‌سازی مشتریان» را بزنید — در حالت افزونه، درخواست در صف
            قرار می‌گیرد و در اجرای بعدی افزونه (معمولاً ظرف چند دقیقه) کل پروندهٔ مشتریان فروشگاه فرستاده می‌شود.
          </div>
        ) : (
          <ul className="divide-y divide-border/80">
            {customers.map((c) => (
              <li key={c.remoteId} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ContactIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-foreground">{c.name || "—"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[c.phone, c.email].filter(Boolean).join(" • ") || "بدون تماس"}
                  </p>
                </div>
                <StatusBadge tone={c.ordersCount > 0 ? "active" : "neutral"}>
                  {toPersianDigits(c.ordersCount)} سفارش آنلاین
                </StatusBadge>
                <span className="text-[11px] text-muted-foreground">
                  {c.lastSeen ? formatJalali(c.lastSeen, { withTime: true }) : ""}
                </span>
                <Link
                  href={crmCustomerHref(c.localId)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
                >
                  پرونده
                  <ExternalLinkIcon className="size-3" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
