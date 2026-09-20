"use client";

/**
 * The store's mirrored customer book: who the customers are on the store
 * side, joined to the local CRM record. Reads /api/integrations/wp-manager/
 * customers; the sync itself is the catalogue button (plugin: queued
 * customer_export job; REST: direct pull).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ContactIcon, RefreshCwIcon, ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, inputClass } from "@/app/dashboard/ui";

import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ConnectionPicker } from "./connection-lite";
import { crmCustomerHref } from "@/app/(app)/crm/crm-routes";
import { PluginWaitNote } from "./plugin-wait-note";
import { useWpStore } from "./wp-store-context";

interface StoreCustomer {
  remoteId: string;
  localId: string;
  name: string;
  phone: string | null;
  email: string | null;
  ordersCount: number;
  lastSeen: string | null;
}

/** A transient line under the toolbar: teal for confirmations, red for failures. */
interface Notice {
  kind: "ok" | "error";
  text: string;
}

export function WpCustomersSection() {
  const { connections, selectedId, setSelectedId } = useWpStore();
  const [customers, setCustomers] = useState<StoreCustomer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [totalPages, setTotalPages] = useState(1);

  // Guards against the two async races this page can hit: late load()
  // responses landing after a newer request (or after unmount) and the
  // post-sync refresh firing after the owner switched to another store.
  const mountedRef = useRef(false);
  const loadSeqRef = useRef(0);
  const selectedRef = useRef("");
  const syncTimerRef = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (syncTimerRef.current !== null) window.clearTimeout(syncTimerRef.current);
    };
  }, []);

  const load = useCallback(async (connectionId: string, nextPage = page, nextPageSize = pageSize, nextQuery = query) => {
    const seq = ++loadSeqRef.current;
    setCustomers(null);
    setLoadError(false);
    const params = new URLSearchParams({
      connectionId,
      page: String(nextPage),
      pageSize: String(nextPageSize),
    });
    if (nextQuery.trim()) params.set("search", nextQuery.trim());
    const res = await api<{
      customers: StoreCustomer[];
      total?: number;
      page?: number;
      pageSize?: number;
      totalPages?: number;
    }>(`/api/integrations/wp-manager/customers?${params.toString()}`);
    // A newer selection (or unmount) supersedes this response.
    if (!mountedRef.current || seq !== loadSeqRef.current) return;
    if (res.ok) {
      setCustomers(res.data.customers);
      setTotal(typeof res.data.total === "number" ? res.data.total : res.data.customers.length);
      // The server resolves the page: it counts first and clamps a request
      // past the end onto the last page that has rows. Adopting its answer is
      // what stops the footer saying «صفحه ۱۳ از ۲» next to an empty list
      // after a search narrowed the result set under the current page.
      setPage(typeof res.data.page === "number" ? res.data.page : nextPage);
      setPageSize(typeof res.data.pageSize === "number" ? res.data.pageSize : nextPageSize);
      setTotalPages(typeof res.data.totalPages === "number" ? Math.max(1, res.data.totalPages) : 1);
    } else {
      // Not an empty list — a failed read. Reported as such, with a retry,
      // rather than the «nothing synced yet» copy that would send the owner
      // re-syncing a store whose data simply failed to load.
      setCustomers([]);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    selectedRef.current = selectedId;
    setNotice(null);
    setQuery("");
    setPage(1);
  }, [selectedId]);

  useEffect(() => {
    if (selectedId) void load(selectedId, page, pageSize, query);
  }, [selectedId, page, pageSize, query, load]);

  async function syncCustomers() {
    const connectionId = selectedId;
    if (!connectionId || busy) return;
    setBusy(true);
    setNotice(null);
    const res = await api<{
      queued?: boolean;
      created?: number;
      updated?: number;
      error?: unknown;
    }>(`/api/integrations/connections/${connectionId}/sync/customers`, { method: "POST" });
    if (!mountedRef.current) return;
    setBusy(false);
    if (!res.ok) {
      const raw = typeof res.data?.error === "string" ? res.data.error : "";
      setNotice({
        kind: "error",
        text:
          raw && raw !== "not_found"
            ? `همگام‌سازی مشتریان ناموفق بود: ${raw}`
            : "همگام‌سازی مشتریان با خطا مواجه شد؛ دوباره تلاش کنید.",
      });
      return;
    }
    if (res.data?.queued) {
      setNotice({
        kind: "ok",
        text: "درخواست همگام‌سازی در صف قرار گرفت؛ با اجرای بعدی افزونه مشتریان می‌رسند.",
      });
      // One opportunistic refresh — unless the owner has moved to another
      // store by then, in which case refetching this one would only repaint
      // the wrong list under the new selection.
      syncTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current && selectedRef.current === connectionId) void load(connectionId, page, pageSize, query);
      }, 3000);
    } else {
      setNotice({
        kind: "ok",
        text: `همگام‌سازی انجام شد (${toPersianDigits(Number(res.data?.created ?? 0))} تازه، ${toPersianDigits(
          Number(res.data?.updated ?? 0),
        )} به‌روزرسانی).`,
      });
      // REST pulls apply inside the request, so the fresh list is ready now.
      void load(connectionId, page, pageSize, query);
    }
  }

  // Search is resolved **server-side**, over the whole mapped book, and the
  // rows that come back are already the matches for this page. Re-filtering
  // them in the browser was a second, narrower filter on top of the first: it
  // hid rows the server had matched (a Persian-digit phone that the server
  // matched on `remote_id`, say) and made the count under the box describe the
  // page rather than the result. One filter, on the server.
  const needle = query.trim();
  const visible = customers ?? [];

  if (connections === null) return <SectionCardSkeleton rows={6} />;
  if (connections.length === 0) {
    return (
      <EmptyState>
        فروشگاهی متصل نیست. ابتدا از بخش{" "}
        <Link
          href="/settings/connections?tab=woocommerce"
          className="font-medium text-teal-700 underline underline-offset-4 hover:text-teal-900 dark:text-teal-300 dark:hover:text-teal-100"
        >
          اتصال‌های فنی
        </Link>{" "}
        یک فروشگاه ووکامرس متصل کنید.
      </EmptyState>
    );
  }

  return (
    <div className="space-y-4">
      <div className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}>
        <ConnectionPicker embedded connections={connections} value={selectedId} onChange={setSelectedId} />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !selectedId}
          onClick={() => void syncCustomers()}
          className="ms-auto w-full sm:w-auto"
        >
          <RefreshCwIcon className="size-4" />
          {busy ? "در حال ارسال درخواست…" : "همگام‌سازی مشتریان"}
        </Button>
      </div>
      <PluginWaitNote connections={connections} selectedId={selectedId} />
      {notice ? (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={
            notice.kind === "error"
              ? "text-xs text-red-700 dark:text-red-300"
              : "text-xs text-teal-700 dark:text-teal-300"
          }
        >
          {notice.text}
        </p>
      ) : null}

      <section className={`${cardClass} overflow-hidden`}>
        <div className="border-b border-border/80 px-4 py-4 sm:px-5">
          <h2 className="font-semibold text-foreground">مشتریان همگام‌شده</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {customers === null && !loadError
              ? "در حال بارگیری…"
              : loadError
                ? "فهرست مشتریان خوانده نشد."
                : `${toPersianDigits(total)} مشتری از فروشگاه به پروندهٔ مشتریان سیستم متصل است. صفحه ${toPersianDigits(page)} از ${toPersianDigits(totalPages)}.`}
          </p>
        </div>

        {/* The toolbar stays while a search is active even when that search
            matched nothing — hiding it was a dead end, because the only way
            back to the full list was the one control that had just vanished. */}
        {customers !== null && (customers.length > 0 || needle) ? (
          <div className="border-b border-border/80 px-4 py-3 sm:px-5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className={`${inputClass} sm:max-w-72`}
                placeholder="جست‌وجو در نام، تلفن یا ایمیل…"
                aria-label="جست‌وجو در مشتریان"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                تعداد در صفحه
                <select
                  className={`${inputClass} w-auto py-1.5 text-xs`}
                  aria-label="تعداد ردیف در هر صفحه"
                  value={pageSize}
                  onChange={(e) => {
                    // A bigger page means fewer pages: go back to the first one
                    // rather than keeping a page number the new size may not have.
                    setPageSize(Number(e.target.value));
                    setPage(1);
                  }}
                >
                  {[10, 25, 50, 100].map((size) => (
                    <option key={size} value={size}>
                      {toPersianDigits(size)}
                    </option>
                  ))}
                </select>
              </label>
              {needle ? (
                <span className="text-xs text-muted-foreground">
                  {toPersianDigits(total)} نتیجه برای این جست‌وجو
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {loadError ? (
          <div className="px-4 py-8 text-center sm:px-5">
            <p className="text-sm text-red-700 dark:text-red-300">بارگیری فهرست مشتریان ناموفق بود.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => selectedId && void load(selectedId, page, pageSize, query)}
            >
              تلاش دوباره
            </Button>
          </div>
        ) : customers === null ? (
          <div className="p-4 sm:p-5">
            <LoadingSkeleton rows={4} label="در حال بارگیری مشتریان" />
          </div>
        ) : visible.length === 0 ? (
          needle ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
              <p>با این جست‌وجو مشتری‌ای پیدا نشد.</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => { setQuery(""); setPage(1); }}>
                پاک کردن جست‌وجو
              </Button>
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground sm:px-5">
              هنوز مشتری‌ای از فروشگاه همگام نشده است. «همگام‌سازی مشتریان» را بزنید — در حالت افزونه، درخواست در صف
              قرار می‌گیرد و در اجرای بعدی افزونه (معمولاً ظرف چند دقیقه) کل پروندهٔ مشتریان فروشگاه فرستاده می‌شود.
            </div>
          )
        ) : (
          <ul className="divide-y divide-border/80">
            {visible.map((c) => (
              <li key={c.remoteId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <ContactIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1 basis-40">
                  <p className="truncate font-medium text-foreground">{c.name || "بدون نام"}</p>
                  <p dir="auto" className="truncate text-right text-xs text-muted-foreground">
                    {[c.phone, c.email].filter(Boolean).join(" • ") || "بدون تماس"}
                  </p>
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                  <StatusBadge tone={c.ordersCount > 0 ? "active" : "neutral"}>
                    {toPersianDigits(c.ordersCount)} سفارش آنلاین
                  </StatusBadge>
                  {c.lastSeen ? (
                    <span className="text-[11px] text-muted-foreground">
                      {formatJalali(c.lastSeen, { withTime: true })}
                    </span>
                  ) : null}
                  <Link
                    href={crmCustomerHref(c.localId)}
                    aria-label={`پروندهٔ ${c.name || "مشتری"}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-foreground/80 transition-colors hover:bg-stone-50 dark:hover:bg-stone-800"
                  >
                    پرونده
                    <ExternalLinkIcon className="size-3" />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
        {customers !== null && totalPages > 1 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/80 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <span>
              صفحه {toPersianDigits(page)} از {toPersianDigits(totalPages)} — نمایش {toPersianDigits(visible.length)} از {toPersianDigits(total)} ردیف
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
                قبلی
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                بعدی
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
