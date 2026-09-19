"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Phase 38 — the four surfaces that turn «فروشگاه ووکامرس» from a connection
 * tester into somewhere an owner can actually work:
 *
 *   «کاتالوگ»             every synced product with its WooCommerce type, its
 *                         categories, its variation attributes and its live
 *                         stock — and a price/stock push from the row itself.
 *   «دسته‌بندی‌ها»          the store's taxonomy tree, including attribute
 *                         terms and custom taxonomies.
 *   «سفارش‌های فروشگاه»    what arrived from the store, and the two things
 *                         anyone does about an order: change its status,
 *                         or refund it.
 *   «تنظیمات همگام‌سازی»   what is pulled, how far back, and when it last ran.
 *
 * Every write here is queued, never applied inline — the response says so. In
 * plugin mode the app cannot reach the store at all, so an inline call would
 * simply fail there; through the outbox the same button works in both modes
 * and inherits retry, backoff and a visible trail.
 */
import { useCallback, useEffect, useState } from "react";
import { api, InfoBox, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { normalizeNumericText } from "@/lib/digits";
import { formatDateTime } from "./format";

export { formatDateTime } from "./format";
/** Money in Toman, the way every other screen in the dashboard shows it. */
function rialToTomanText(rial: string | null): string {
  if (rial === null) return "—";
  try {
    const value = BigInt(rial);
    const toman = value / 10n;
    return toman.toLocaleString("fa-IR");
  } catch {
    // A malformed value from an old sync must not crash the whole catalogue.
    return "نامعتبر";
  }
}

/** Persian labels for the WooCommerce types a row can be. */
export const WOO_TYPE_LABELS: Record<string, string> = {
  simple: "ساده",
  variable: "متغیر (والد)",
  variation: "تنوع",
  grouped: "گروهی",
  external: "خارجی",
  bundle: "بسته",
  composite: "ترکیبی",
  subscription: "اشتراک",
  unknown: "نامشخص",
};

export const PRODUCT_STATUS_LABELS: Record<string, string> = {
  publish: "منتشرشده",
  draft: "پیش‌نویس",
  pending: "در انتظار",
  private: "خصوصی",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  processing: "در حال پردازش",
  "on-hold": "معلق",
  completed: "تکمیل‌شده",
  cancelled: "لغو شده",
  refunded: "برگشت خورده",
  failed: "ناموفق",
};

const INGEST_STATUS_LABELS: Record<string, string> = {
  processed: "ثبت شد",
  duplicate: "تکراری",
  failed: "خطا",
  pending: "در انتظار",
  none: "—",
};

interface SectionProps {
  connectionId: string;
  /** True while any request for this connection is in flight. */
  busy: boolean;
  /** The panel's request helper, so a failure shows in the panel's own banner. */
  call: <T extends Record<string, unknown>>(path: string, method?: string, body?: unknown) => Promise<T | null>;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface CatalogueProduct {
  remoteId: string;
  localId: string;
  name: string;
  sku: string | null;
  wooType: string;
  itemKind: string | null;
  sellable: boolean;
  priceRial: string | null;
  quantity: number | null;
  parentRemoteId: string | null;
  categories: string[];
  attributes: string[];
}

export function CatalogueSection({ connectionId, busy, call }: SectionProps) {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState<CatalogueProduct[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ price: "", stock: "" });
  const [loadError, setLoadError] = useState("");
  const [validationError, setValidationError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    const { ok, data } = await api<{
      products?: CatalogueProduct[];
      summary?: Record<string, number>;
      error?: string;
    }>(`/api/integrations/connections/${connectionId}/catalogue`);
    if (ok) {
      setProducts(data.products ?? []);
      setSummary(data.summary ?? null);
    } else {
      setProducts([]);
      setSummary(null);
      setLoadError(String(data?.error ?? "دریافت محصولات ناموفق بود."));
    }
    setLoading(false);
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const types = [...new Set(products.map((p) => p.wooType))].sort();
  const needle = query.trim().toLowerCase();
  const visible = products.filter((p) => {
    if (typeFilter && p.wooType !== typeFilter) return false;
    if (!needle) return true;
    return (
      p.name.toLowerCase().includes(needle) ||
      (p.sku ?? "").toLowerCase().includes(needle) ||
      p.categories.some((c) => c.toLowerCase().includes(needle)) ||
      p.attributes.some((a) => a.toLowerCase().includes(needle))
    );
  });

  async function push(remoteId: string) {
    setValidationError("");
    const fields: Record<string, unknown> = {};
    if (draft.price.trim()) {
      // Persian/Arabic digits and pasted grouping separators are accepted.
      const canonical = normalizeNumericText(draft.price, { allowDecimal: false, allowNegative: false });
      if (!canonical || !/^\d+$/.test(canonical)) {
        setValidationError("قیمت باید یک عدد صحیح و نامنفی باشد.");
        return;
      }
      fields.priceRial = (BigInt(canonical) * 10n).toString();
    }
    if (draft.stock.trim()) {
      const canonical = normalizeNumericText(draft.stock, { allowDecimal: false, allowNegative: false });
      if (!canonical || !/^\d+$/.test(canonical)) {
        setValidationError("موجودی باید یک عدد صحیح و نامنفی باشد.");
        return;
      }
      const stock = Number(canonical);
      if (!Number.isSafeInteger(stock)) {
        setValidationError("موجودی واردشده بیش از حد بزرگ است.");
        return;
      }
      fields.stock_quantity = stock;
    }
    if (Object.keys(fields).length === 0) {
      setValidationError("حداقل قیمت یا موجودی جدید را وارد کنید.");
      return;
    }
    const result = await call<Record<string, unknown>>(
      `/api/integrations/connections/${connectionId}/store/products`,
      "POST",
      { remoteId, fields },
    );
    if (result) {
      setEditing(null);
      setDraft({ price: "", stock: "" });
    }
  }

  return (
    <section className="mt-2 space-y-4 rounded-xl bg-muted p-3 text-sm sm:p-4" aria-busy={loading} aria-label="فهرست محصولات ووکامرس">
      {loading ? <LoadingSkeleton rows={5} compact /> : null}
      {!loading && loadError ? (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-red-700 sm:flex-row sm:items-center sm:justify-between dark:text-red-300">
          <span>{loadError}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>تلاش دوباره</Button>
        </div>
      ) : null}

      {!loading && summary ? (
        <div className="flex flex-wrap gap-2">
          {[
            { label: "کل", value: summary.total ?? 0 },
            { label: "قابل فروش", value: summary.sellable ?? 0 },
            { label: "تنوع", value: summary.variations ?? 0 },
            { label: "والد/گروه", value: summary.containers ?? 0 },
            { label: "ناموجود", value: summary.outOfStock ?? 0 },
            { label: "بدون دسته", value: summary.uncategorised ?? 0 },
          ].map((chip) => (
            <span key={chip.label} className="rounded-full bg-card px-2 py-0.5 text-[11px] text-foreground/80">
              {chip.label}: {Number(chip.value).toLocaleString("fa-IR")}
            </span>
          ))}
        </div>
      ) : null}

      {!loading && products.length > 0 ? (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
          <label className="grid gap-1">
            <span className="text-xs font-medium">جست‌وجوی محصول</span>
            <input
              className={`${inputClass} w-full`}
              placeholder="نام، SKU، دسته یا ویژگی…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="grid gap-1">
            <span className="text-xs font-medium">نوع محصول</span>
            <select className={`${inputClass} w-full`} value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">همهٔ نوع‌ها</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {WOO_TYPE_LABELS[type] ?? type}
              </option>
            ))}
            </select>
          </label>
          <Button type="button" variant="outline" className="w-full sm:w-auto" disabled={!query && !typeFilter} onClick={() => { setQuery(""); setTypeFilter(""); }}>
            پاک‌کردن فیلتر
          </Button>
          <p className="text-xs text-muted-foreground sm:col-span-3" aria-live="polite">
            نمایش {visible.length.toLocaleString("fa-IR")} از {products.length.toLocaleString("fa-IR")} محصول
          </p>
        </div>
      ) : null}

      {!loading && !loadError && products.length === 0 ? (
        <p className="text-muted-foreground">
          هنوز محصولی همگام‌سازی نشده است. دکمهٔ «همگام‌سازی محصولات» را بزنید.
        </p>
      ) : null}

      {visible.length === 0 && !loading && products.length > 0 ? (
        <p className="text-muted-foreground">محصولی با این فیلتر پیدا نشد.</p>
      ) : null}

      <ul className="grid gap-2 lg:grid-cols-2">
        {visible.map((product) => (
          <li key={product.remoteId} className="rounded-lg border border-border/70 bg-card p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{product.name}</span>
              <span className="flex flex-wrap items-center gap-1">
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground/80">
                  {WOO_TYPE_LABELS[product.wooType] ?? product.wooType}
                </span>
                {product.parentRemoteId ? (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" dir="ltr">
                    والد #{product.parentRemoteId}
                  </span>
                ) : null}
                {product.sku ? (
                  <span className="text-[10px] text-muted-foreground" dir="ltr">
                    {product.sku}
                  </span>
                ) : null}
              </span>
            </div>

            {product.attributes.length > 0 ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{product.attributes.join("، ")}</p>
            ) : null}

            <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>قیمت: {rialToTomanText(product.priceRial)} تومان</span>
              {product.quantity !== null ? <span>موجودی: {product.quantity.toLocaleString("fa-IR")}</span> : null}
              {product.categories.length > 0 ? <span>دسته: {product.categories.join("، ")}</span> : null}
            </div>

            {product.sellable ? (
              editing === product.remoteId ? (
                <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 sm:grid-cols-2">
                  <label className="grid gap-1">
                    <span className="text-xs font-medium">قیمت جدید (تومان)</span>
                    <input
                      className={`${inputClass} w-full`}
                      placeholder="مثلاً ۱۵۰٬۰۰۰"
                      inputMode="numeric"
                      value={draft.price}
                      onChange={(e) => { setDraft({ ...draft, price: e.target.value }); setValidationError(""); }}
                    />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-xs font-medium">موجودی جدید</span>
                    <input
                      className={`${inputClass} w-full`}
                      placeholder="مثلاً ۱۲"
                      inputMode="numeric"
                      value={draft.stock}
                      onChange={(e) => { setDraft({ ...draft, stock: e.target.value }); setValidationError(""); }}
                    />
                  </label>
                  {validationError ? <p role="alert" className="text-xs text-red-600 sm:col-span-2 dark:text-red-400">{validationError}</p> : null}
                  <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row">
                  <Button type="button" size="xs" disabled={busy} onClick={() => void push(product.remoteId)}>
                    ارسال به فروشگاه
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setEditing(null);
                      setDraft({ price: "", stock: "" });
                    }}
                  >
                    انصراف
                  </Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="mt-2"
                  onClick={() => {
                    setEditing(product.remoteId);
                    setDraft({ price: "", stock: "" });
                  }}
                >
                  تغییر قیمت / موجودی
                </Button>
              )
            ) : (
              <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                این ردیف والدِ تنوع‌هاست؛ خودش فروخته نمی‌شود و موجودی و قیمت ندارد.
              </p>
            )}
          </li>
        ))}
      </ul>
      <InfoBox>
        تغییر قیمت و موجودی در صف قرار می‌گیرد و در اجرای بعدی (خودکار یا افزونهٔ وردپرس) به فروشگاه می‌رود.
      </InfoBox>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

interface TermGroup {
  taxonomy: string;
  label: string;
  isAttribute: boolean;
  termCount: number;
  terms: { remoteId: string; parentRemoteId: string | null; name: string; remoteCount: number; mappedCount: number }[];
}

export function TaxonomiesSection({ connectionId }: { connectionId: string }) {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<TermGroup[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { ok, data } = await api<{ groups?: TermGroup[] }>(
        `/api/integrations/connections/${connectionId}/taxonomies`,
      );
      if (ok && !cancelled) setGroups(data.groups ?? []);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  if (loading) {
    return (
      <LoadingSkeleton rows={3} compact className="mt-2" />
    );
  }

  if (groups.length === 0) {
    return (
      <div className="mt-2 rounded-xl bg-muted p-2 text-xs text-muted-foreground">
        هنوز درخت دسته‌بندی دریافت نشده است. پس از «همگام‌سازی محصولات»، دسته‌ها، برچسب‌ها و ویژگی‌های فروشگاه اینجا
        دیده می‌شوند.
      </div>
    );
  }

  return (
    <div className="mt-2 max-h-80 space-y-1 overflow-y-auto rounded-xl bg-muted p-2 text-xs">
      {groups.map((group) => (
        <div key={group.taxonomy} className="rounded-lg border border-border/70 bg-card">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 p-2 text-right"
            aria-expanded={open === group.taxonomy}
            onClick={() => setOpen(open === group.taxonomy ? null : group.taxonomy)}
          >
            <span className="font-medium">{group.label}</span>
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {group.isAttribute ? <span className="rounded-full bg-muted px-2 py-0.5">ویژگی</span> : null}
              <span>
                {group.termCount.toLocaleString("fa-IR")} مورد
              </span>
              <span dir="ltr" className="font-mono text-[10px]">
                {group.taxonomy}
              </span>
            </span>
          </button>
          {open === group.taxonomy ? (
            <ul className="space-y-1 border-t border-border p-2">
              {group.terms.map((term) => (
                <li key={term.remoteId} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {term.parentRemoteId ? <span className="text-muted-foreground">└ </span> : null}
                    {term.name}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    در فروشگاه: {term.remoteCount.toLocaleString("fa-IR")} • همگام‌شده:{" "}
                    {term.mappedCount.toLocaleString("fa-IR")}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Store orders
// ---------------------------------------------------------------------------

interface StoreOrder {
  remoteId: string;
  localOrderId: string | null;
  localOrderNumber: number | null;
  number: string;
  status: string;
  total: string;
  dateCreated: string | null;
  customer: string;
  ingestStatus: string;
  ingestError: string | null;
  lineCount: number;
}

export function StoreOrdersSection({ connectionId, busy, call }: SectionProps) {
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<StoreOrder[]>([]);
  const [statusFor, setStatusFor] = useState<string | null>(null);
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ orders?: StoreOrder[] }>(
      `/api/integrations/connections/${connectionId}/store/orders`,
    );
    if (ok) setOrders(data.orders ?? []);
    setLoading(false);
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mt-2 max-h-80 space-y-1 overflow-y-auto rounded-xl bg-muted p-2 text-xs">
      {loading ? <LoadingSkeleton rows={3} compact /> : null}
      {!loading && orders.length === 0 ? (
        <p className="text-muted-foreground">
          سفارشی از فروشگاه دریافت نشده است. «همگام‌سازی سفارش‌ها» را بزنید یا از برقراری وب‌هوک مطمئن شوید.
        </p>
      ) : null}

      {orders.map((order) => (
        <div key={order.remoteId} className="rounded-lg border border-border/70 bg-card p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium" dir="ltr">
              #{order.number}
            </span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-foreground/80">
              {ORDER_STATUS_LABELS[order.status] ?? order.status}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
            <span>{order.customer || "بدون نام"}</span>
            <span>
              {order.lineCount.toLocaleString("fa-IR")} قلم • {order.total}
            </span>
            <span>{formatDateTime(order.dateCreated)}</span>
            <span>
              {order.localOrderNumber !== null
                ? `فاکتور داخلی: ${order.localOrderNumber.toLocaleString("fa-IR")}`
                : "در حسابداری ثبت نشده"}
            </span>
            <span className={order.ingestStatus === "failed" ? "text-red-600 dark:text-red-400" : ""}>
              {INGEST_STATUS_LABELS[order.ingestStatus] ?? order.ingestStatus}
            </span>
          </div>
          {order.ingestError ? <p className="mt-1 text-red-600 dark:text-red-400" dir="ltr">{order.ingestError}</p> : null}

          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setStatusFor(statusFor === order.remoteId ? null : order.remoteId);
                setRefundFor(null);
              }}
            >
              تغییر وضعیت
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setRefundFor(refundFor === order.remoteId ? null : order.remoteId);
                setStatusFor(null);
                setAmount(order.total);
              }}
            >
              ثبت برگشت وجه
            </Button>
          </div>

          {statusFor === order.remoteId ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {Object.keys(ORDER_STATUS_LABELS).map((status) => (
                <Button
                  key={status}
                  type="button"
                  size="xs"
                  variant={status === order.status ? "default" : "ghost"}
                  disabled={busy}
                  onClick={async () => {
                    const result = await call<Record<string, unknown>>(
                      `/api/integrations/connections/${connectionId}/store/orders`,
                      "POST",
                      { action: "status", remoteId: order.remoteId, status },
                    );
                    if (result) {
                      setStatusFor(null);
                      await load();
                    }
                  }}
                >
                  {ORDER_STATUS_LABELS[status]}
                </Button>
              ))}
            </div>
          ) : null}

          {refundFor === order.remoteId ? (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-2">
                <input
                  className={inputClass}
                  placeholder="مبلغ برگشتی (واحد فروشگاه)"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  dir="ltr"
                />
                <input
                  className={inputClass}
                  placeholder="دلیل (اختیاری)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <Button
                  type="button"
                  size="xs"
                  disabled={busy}
                  onClick={async () => {
                    const result = await call<Record<string, unknown>>(
                      `/api/integrations/connections/${connectionId}/store/orders`,
                      "POST",
                      { action: "refund", remoteId: order.remoteId, amount, reason },
                    );
                    if (result) {
                      setRefundFor(null);
                      setAmount("");
                      setReason("");
                      await load();
                    }
                  }}
                >
                  ثبت در صف
                </Button>
              </div>
              <InfoBox>
                این عملیات فقط برگشت وجه را در فروشگاه ثبت می‌کند؛ بازگرداندن وجه به کارت مشتری از طریق درگاه پرداخت
                انجام نمی‌شود و باید در ووکامرس انجام گیرد.
              </InfoBox>
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync settings
// ---------------------------------------------------------------------------

export interface SyncSettingsConnection {
  id: string;
  linkMode: "rest_api" | "plugin";
  syncCategories: boolean;
  autoPullOrders: boolean;
  orderLookbackDays: number;
  lastCatalogueSyncAt: string | null;
  lastOrderSyncAt: string | null;
}

export function SyncSettingsSection({
  connection,
  busy,
  call,
}: {
  connection: SyncSettingsConnection;
  busy: boolean;
  call: <T extends Record<string, unknown>>(path: string, method?: string, body?: unknown) => Promise<T | null>;
}) {
  const [lookback, setLookback] = useState(String(connection.orderLookbackDays));
  const [dirty, setDirty] = useState(false);

  const toggle = async (patch: Record<string, unknown>) => {
    await call(`/api/integrations/connections/${connection.id}`, "PATCH", patch);
  };

  return (
    <div className="mt-2 space-y-3 rounded-xl bg-muted p-2 text-xs">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={connection.autoPullOrders}
            disabled={busy}
            onChange={(e) => void toggle({ autoPullOrders: e.target.checked })}
          />
          <span>
            <span className="font-medium">دریافت دوره‌ای سفارش‌ها</span>
            <span className="block text-[11px] leading-5 text-muted-foreground">
              {connection.linkMode === "plugin"
                ? "در حالت افزونه، خودِ افزونه سفارش‌ها را می‌فرستد؛ این گزینه یک بازخوانی کاملِ دوره‌ای هم درخواست می‌کند."
                : "علاوه بر وب‌هوک، سفارش‌های اخیر به‌طور دوره‌ای هم خوانده می‌شود؛ وب‌هوکی که تنظیم نشده باشد دیگر به معنای از دست رفتن فروش نیست."}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={connection.syncCategories}
            disabled={busy}
            onChange={(e) => void toggle({ syncCategories: e.target.checked })}
          />
          <span>
            <span className="font-medium">ساخت دسته‌بندی از فروشگاه</span>
            <span className="block text-[11px] leading-5 text-muted-foreground">
              دسته‌های ووکامرس به دسته‌بندی‌های منو/کالا اضافه می‌شوند. به‌طور پیش‌فرض خاموش است، چون چیدمان موجود را
              تغییر می‌دهد.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <span className="mb-1 block text-[11px] text-muted-foreground">بازهٔ بازخوانی سفارش‌ها (روز)</span>
          <input
            className={inputClass}
            value={lookback}
            onChange={(e) => {
              setLookback(e.target.value);
              setDirty(true);
            }}
            inputMode="numeric"
            dir="ltr"
          />
        </div>
        <Button
          type="button"
          size="xs"
          disabled={busy || !dirty}
          onClick={async () => {
            const days = Math.min(365, Math.max(1, Math.round(Number(lookback) || 7)));
            setLookback(String(days));
            setDirty(false);
            await call(`/api/integrations/connections/${connection.id}`, "PATCH", { orderLookbackDays: days });
          }}
        >
          ذخیرهٔ بازه
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() =>
            call(`/api/integrations/connections/${connection.id}/sync/orders`, "POST", {
              sinceDays: Number(lookback) || undefined,
            })
          }
        >
          همگام‌سازی سفارش‌ها
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span>آخرین همگام‌سازی محصولات: {formatDateTime(connection.lastCatalogueSyncAt)}</span>
        <span>آخرین همگام‌سازی سفارش‌ها: {formatDateTime(connection.lastOrderSyncAt)}</span>
      </div>

      <InfoBox>
        در حالت افزونهٔ وردپرس، زمان‌بندی همگام‌سازی در خودِ وردپرس است: رویدادها هر ۵ دقیقه ارسال می‌شوند و
        بازسازی کاملِ کاتالوگ و سفارش‌ها طبق برنامه‌ای که در تنظیمات افزونه انتخاب کرده‌اید اجرا می‌شود.
      </InfoBox>
    </div>
  );
}
