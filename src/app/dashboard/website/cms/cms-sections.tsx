"use client";

/**
 * The Eshobe CMS manager — one of the two managers inside «مدیریت وب‌سایت».
 *
 * The other is the WordPress/WooCommerce manager (`../wp`). They are peers and
 * they stay apart: this file talks only to the platform's own site builder
 * over `src/lib/cms/`, and never to a WordPress store.
 *
 * Four sections, one per page of the manager, all over the same headless CMS
 * API. The browser never sees a CMS key: the wizard and the connect form POST
 * the credential once, the server stores it encrypted (migration 0122) and
 * every later call uses the stored site key server-side.
 *
 * Each section reads the same one overview call — the site's descriptor
 * (theme, locales, store currency), its pages, its catalogue and its orders —
 * because that is one cached round trip on the CMS side and it keeps the four
 * screens from disagreeing about what the site contains. Order status changes
 * are the one e-commerce write here; back on the CMS their own hooks settle
 * stock and snapshot the change.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CircleCheckIcon,
  ExternalLinkIcon,
  GlobeIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatPersianNumber, toLatinDigits, toPersianDigits } from "@/lib/digits";
import type { CmsConnectionSummary } from "@/lib/cms/connections";
import { lexicalToPlainText, type CmsOrder, type CmsPost, type CmsProduct, type SiteDescriptor } from "@/lib/cms/types";
import { Skeleton } from "@/components/ui/skeleton";
import {
  cardClass,
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  api,
  errorMessageOrRaw,
  Field,
  inputClass,
  SecondaryButton,
  ErrorBox,
} from "@/app/dashboard/ui";
import { cmsDnsHint } from "@/lib/cms/dns";
import type { CmsDnsStatus, WebsiteOverview } from "@/lib/cms/website-service";
import { cmsSectionHref } from "../website-routes";
import { CmsSyncSettings } from "./cms-sync-settings";

const TYPE_LABELS: Record<string, string> = {
  business: "کسب‌وکار",
  portfolio: "نمونه‌کار",
  store: "فروشگاه",
};

const STATUS_LABELS: Record<string, string> = {
  active: "فعال",
  suspended: "معلق",
  archived: "بایگانی‌شده",
  published: "منتشرشده",
  draft: "پیش‌نویس",
};

const LOCALE_LABELS: Record<string, string> = { fa: "فارسی", en: "انگلیسی" };

const CURRENCY_LABELS: Record<string, string> = {
  IRT: "تومان",
  IRR: "ریال",
  EUR: "€",
  USD: "$",
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار پرداخت",
  paid: "پرداخت‌شده",
  cancelled: "لغو شده",
  refunded: "بازگشت خورده",
};

const ORDER_STATUS_TONE: Record<string, "active" | "positive" | "neutral" | "danger"> = {
  pending: "active",
  paid: "positive",
  cancelled: "neutral",
  refunded: "danger",
};

/* ------------------------------------------------------------------ */
/* The shared read every section of this manager starts from           */
/* ------------------------------------------------------------------ */

interface CmsSite {
  loading: boolean;
  connection: CmsConnectionSummary | null;
  overview: WebsiteOverview | null;
  overviewError: string;
  dnsStatus: CmsDnsStatus | null;
  dnsLoading: boolean;
  reload: () => void;
  loadOverview: () => void;
  checkDns: () => void;
  setOverview: React.Dispatch<React.SetStateAction<WebsiteOverview | null>>;
}

function useCmsSite({ withDns = false }: { withDns?: boolean } = {}): CmsSite {
  const [connection, setConnection] = useState<CmsConnectionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<WebsiteOverview | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [dnsStatus, setDnsStatus] = useState<CmsDnsStatus | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);

  const loadOverview = useCallback(() => {
    api<{ overview: WebsiteOverview }>("/api/cms/website/overview").then(({ ok, data }) => {
      if (ok) {
        setOverview(data.overview);
        setOverviewError("");
      } else {
        setOverview(null);
        setOverviewError(errorMessageOrRaw((data as { error?: string }).error));
      }
    });
  }, []);

  const checkDns = useCallback(() => {
    setDnsLoading(true);
    api<{ status: CmsDnsStatus }>("/api/cms/website/dns").then(({ ok, data }) => {
      setDnsLoading(false);
      if (ok) setDnsStatus(data.status);
      else toast.error("بررسی DNS ناموفق بود.");
    });
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    api<{ connected: boolean; connection: CmsConnectionSummary | null }>("/api/cms/website/state").then(
      ({ ok, data }) => {
        setLoading(false);
        if (!ok) return;
        setConnection(data.connection);
        if (data.connection) {
          loadOverview();
          if (withDns) checkDns();
        } else {
          setOverview(null);
          setDnsStatus(null);
        }
      },
    );
  }, [loadOverview, checkDns, withDns]);

  useEffect(reload, [reload]);

  return {
    loading,
    connection,
    overview,
    overviewError,
    dnsStatus,
    dnsLoading,
    reload,
    loadOverview,
    checkDns,
    setOverview,
  };
}

/**
 * What every section but the overview shows when there is no site yet.
 *
 * A section of a site that does not exist is a dead end, so it points at the
 * one screen that can change that. The nav already hides these sections; this
 * is for a bookmark or a typed URL.
 */
function NoSiteYet({ what }: { what: string }) {
  return (
    <SectionCard title={what} description="برای این بخش، اول باید سایتی روی سایت‌ساز داشته باشید.">
      <EmptyState>هنوز سایتی ساخته یا وصل نشده است.</EmptyState>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild variant="outline" className="px-4">
          <Link href="/dashboard/connections?tab=website">
            <PlugZapIcon className="size-4" />
            اتصال سایت موجود
          </Link>
        </Button>
        <Button asChild variant="outline" className="px-4">
          <Link href={cmsSectionHref("setup")}>
            <GlobeIcon className="size-4" />
            ساخت سایت جدید
          </Link>
        </Button>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* میز کار سایت — connection, domain and the live preview              */
/* ------------------------------------------------------------------ */

export function CmsOverviewSection() {
  const site = useCmsSite({ withDns: true });
  const [previewReady, setPreviewReady] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [editingDomain, setEditingDomain] = useState(false);

  if (site.loading) return <SectionCardSkeleton rows={4} />;

  if (!site.connection) {
    return (
      <SectionCard
        title="هنوز سایتی ندارید"
        description="سایت اینترنتی کسب‌وکار را روی سایت‌ساز پلتفرم بسازید، یا سایتی که قبلاً ساخته‌اید را وصل کنید."
      >
        <EmptyState>ساخت سایت چهار گام دارد: دامنه، CDN، نوع سایت و ساخت.</EmptyState>
        <div className="mt-3">
          <Button asChild className="px-4">
            <Link href={cmsSectionHref("setup")}>
              <GlobeIcon className="size-4" />
              شروع ساخت سایت
            </Link>
          </Button>
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="اتصال به سایت"
        description={`${site.connection.siteDomain} — محتوای سایت و فروشگاه از سایت‌ساز پلتفرم خوانده می‌شود.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={site.reload}>
              <RefreshCwIcon className="size-4" />
              بروزرسانی
            </SecondaryButton>
            <Button
              type="button"
              variant="outline"
              className="px-4"
              onClick={() => window.open(`${site.connection!.baseUrl}/admin`, "_blank", "noopener")}
            >
              <ExternalLinkIcon className="size-4" />
              مدیریت محتوا در سایت‌ساز
            </Button>
          </div>
        }
      >
        <ErrorBox>{site.overviewError}</ErrorBox>
        {site.overview ? (
          <SiteSummary site={site.overview.site} />
        ) : (
          <p className="text-sm text-muted-foreground">اتصال برقرار است؛ برای بارگذاری محتوا بروزرسانی را بزنید.</p>
        )}
      </SectionCard>

      <DnsChecklistCard
        status={site.dnsStatus}
        loading={site.dnsLoading}
        onCheck={site.checkDns}
        baseUrl={site.connection.baseUrl}
        currentDomain={site.connection.siteDomain}
        onEditDomain={() => setEditingDomain(true)}
      />

      <PreviewCard
        status={site.dnsStatus}
        ready={previewReady}
        frameKey={previewKey}
        onLoad={() => setPreviewReady(true)}
        onRefresh={() => {
          setPreviewReady(false);
          setPreviewKey((key) => key + 1);
        }}
      />

      {editingDomain ? (
        <DomainDialog
          currentDomain={site.connection.siteDomain}
          onClose={() => setEditingDomain(false)}
          onSaved={() => {
            setEditingDomain(false);
            site.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* محتوا — the site's pages and posts                                  */
/* ------------------------------------------------------------------ */

export function CmsContentSection() {
  const site = useCmsSite();
  const [editingPost, setEditingPost] = useState<CmsPost | "new" | null>(null);

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="محتوای سایت" />;

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{site.overviewError}</ErrorBox>

      <SectionCard title="صفحه‌ها" description="صفحه‌های منتشرشدهٔ سایت (۲۰ صفحهٔ آخر).">
        {!site.overview ? (
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری صفحه‌ها" />
        ) : site.overview.pages.length === 0 ? (
          <EmptyState>هنوز صفحه‌ای ساخته نشده است.</EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {site.overview.pages.map((page) => (
              <li key={page.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{page.title}</p>
                  <p dir="ltr" className="truncate text-xs text-muted-foreground">
                    /{page.slug}
                  </p>
                </div>
                <StatusBadge tone={page._status === "published" ? "positive" : "active"}>
                  {STATUS_LABELS[page._status ?? "draft"]}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="نوشته‌ها"
        description="مطالب وبلاگ سایت (۲۰ نوشتهٔ آخر). یک نوشتهٔ ساخته‌شده از این‌جا به‌صورت پیش‌نویس ذخیره می‌شود؛ انتشار آن از پنل سایت‌ساز انجام می‌شود."
        actions={
          <SecondaryButton onClick={() => setEditingPost("new")}>
            <PlusIcon className="size-4" />
            نوشتهٔ جدید
          </SecondaryButton>
        }
      >
        {!site.overview ? (
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری نوشته‌ها" />
        ) : site.overview.posts.length === 0 ? (
          <EmptyState>هنوز نوشته‌ای ساخته نشده است.</EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {site.overview.posts.map((post) => (
              <li key={post.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{post.title}</p>
                  <p dir="ltr" className="truncate text-xs text-muted-foreground">
                    /{post.slug}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusBadge tone={post._status === "published" ? "positive" : "active"}>
                    {STATUS_LABELS[post._status ?? "draft"]}
                  </StatusBadge>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setEditingPost(post)}
                    aria-label={`ویرایش ${post.title}`}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {editingPost ? (
        <PostDialog
          post={editingPost === "new" ? null : editingPost}
          onClose={() => setEditingPost(null)}
          onSaved={() => {
            setEditingPost(null);
            site.loadOverview();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* فروشگاه — products and the orders the site took                     */
/* ------------------------------------------------------------------ */

export function CmsStoreSection() {
  const site = useCmsSite();
  const [editingProduct, setEditingProduct] = useState<CmsProduct | "new" | null>(null);
  const [updatingOrder, setUpdatingOrder] = useState("");

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="فروشگاه سایت" />;

  const currency = site.overview?.site.store.currency ?? "IRT";

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{site.overviewError}</ErrorBox>

      <SectionCard
        title="محصولات"
        description="فروشگاه آنلاین (۵۰ محصول آخر). محصول ساخته‌شده از این‌جا پیش‌نویس است؛ انتشار از پنل سایت‌ساز انجام می‌شود."
        actions={
          <SecondaryButton onClick={() => setEditingProduct("new")}>
            <PlusIcon className="size-4" />
            محصول جدید
          </SecondaryButton>
        }
      >
        {!site.overview ? (
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری محصول‌ها" />
        ) : site.overview.products.length === 0 ? (
          <EmptyState>فروشگاه هنوز محصولی ندارد.</EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {site.overview.products.map((product) => (
              <li key={product.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{product.title}</p>
                  {product.sku ? <p className="truncate text-xs text-muted-foreground">{product.sku}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <p className="text-sm font-semibold text-foreground">
                    {formatPersianNumber(product.price)}{" "}
                    <span className="text-xs font-normal text-muted-foreground">
                      {CURRENCY_LABELS[currency] ?? currency}
                    </span>
                  </p>
                  <StatusBadge tone={product._status === "published" ? "positive" : "active"}>
                    {STATUS_LABELS[product._status ?? "draft"]}
                  </StatusBadge>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setEditingProduct(product)}
                    aria-label={`ویرایش ${product.title}`}
                  >
                    <PencilIcon className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {site.overview ? (
        <OrdersCard
          orders={site.overview.orders}
          currency={currency}
          updatingOrder={updatingOrder}
          onStatusChange={(order, status) => {
            setUpdatingOrder(order.id);
            api<{ order: CmsOrder }>(`/api/cms/website/orders/${order.id}`, {
              method: "PATCH",
              body: JSON.stringify({ status }),
            }).then(({ ok, data }) => {
              if (ok) {
                site.setOverview((current) =>
                  current
                    ? {
                        ...current,
                        orders: current.orders.map((row) => (row.id === order.id ? data.order : row)),
                      }
                    : current,
                );
                toast.success(`سفارش ${toPersianDigits(order.reference)} ${ORDER_STATUS_LABELS[status] ?? ""} شد.`);
              } else {
                toast.error(errorMessageOrRaw((data as { error?: string }).error));
              }
              setUpdatingOrder("");
            });
          }}
        />
      ) : (
        <SectionCard title="سفارش‌ها" description="سفارش‌های فروشگاه اینترنتی.">
          <LoadingSkeleton rows={3} compact label="در حال بارگذاری سفارش‌ها" />
        </SectionCard>
      )}

      {editingProduct ? (
        <ProductDialog
          product={editingProduct === "new" ? null : editingProduct}
          currency={CURRENCY_LABELS[currency] ?? currency}
          onClose={() => setEditingProduct(null)}
          onSaved={() => {
            setEditingProduct(null);
            site.loadOverview();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* تنظیمات — the connection itself, and what this app pushes to it     */
/* ------------------------------------------------------------------ */

export function CmsSettingsSection() {
  const site = useCmsSite();

  if (site.loading) return <SectionCardSkeleton rows={4} />;
  if (!site.connection) return <NoSiteYet what="تنظیمات همگام‌سازی" />;

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="اتصال سایت"
        description={`سایت «${site.connection.siteDomain}» به همین حساب وصل است. خودِ اتصال — آزمایش، تغییر دامنه و قطع — در «اتصال‌های فنی» مدیریت می‌شود؛ اینجا فقط اینکه چه چیزی به سایت فرستاده شود.`}
      >
        <Button asChild variant="outline" className="px-4">
          <Link href="/dashboard/connections?tab=website">
            <PlugZapIcon className="size-4" />
            مدیریت اتصال در اتصال‌های فنی
          </Link>
        </Button>
      </SectionCard>

      <CmsSyncSettings />
    </div>
  );
}

export function SiteSummary({ site }: { site: SiteDescriptor }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <p className="text-xs text-muted-foreground">نام سایت</p>
        <p className="mt-0.5 truncate text-sm font-medium text-foreground">{site.name}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">دامنه</p>
        <p dir="ltr" className="mt-0.5 truncate text-sm font-medium text-foreground">
          {site.domain}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">نوع و وضعیت</p>
        <p className="mt-0.5 flex items-center gap-2 text-sm font-medium text-foreground">
          {TYPE_LABELS[site.type] ?? site.type}
          <StatusBadge tone={site.status === "active" ? "positive" : site.status === "suspended" ? "active" : "neutral"}>
            {STATUS_LABELS[site.status] ?? site.status}
          </StatusBadge>
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">زبان‌ها و ارز</p>
        <p className="mt-0.5 text-sm font-medium text-foreground">
          {site.availableLocales.map((locale) => LOCALE_LABELS[locale] ?? locale).join("، ")}
          <span className="text-muted-foreground"> · </span>
          {CURRENCY_LABELS[site.store.currency] ?? site.store.currency}
        </p>
      </div>
    </div>
  );
}

function OrdersCard({
  orders,
  currency,
  updatingOrder,
  onStatusChange,
}: {
  orders: CmsOrder[];
  currency: string;
  updatingOrder: string;
  onStatusChange: (order: CmsOrder, status: CmsOrder["status"]) => void;
}) {
  return (
    <SectionCard title="سفارش‌ها" description="تغییر وضعیت، همان کاری است که درگاه و انبار CMS انجام می‌دهند.">
      {orders.length === 0 ? (
        <EmptyState>سفارشی ثبت نشده است.</EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {orders.map((order) => (
            <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {toPersianDigits(order.reference)} — {order.productTitle ?? "محصول"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {toPersianDigits(order.quantity)} عدد · {toPersianDigits(order.buyer.phone)}
                  {" · "}
                  {formatPersianNumber(order.total)}{" "}
                  {CURRENCY_LABELS[currency] ?? currency}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <StatusBadge tone={ORDER_STATUS_TONE[order.status] ?? "neutral"}>
                  {ORDER_STATUS_LABELS[order.status] ?? order.status}
                </StatusBadge>
                <select
                  className={`${inputClass} h-9 w-auto`}
                  value={order.status}
                  disabled={updatingOrder === order.id}
                  onChange={(event) => onStatusChange(order, event.target.value as CmsOrder["status"])}
                  aria-label={`وضعیت سفارش ${toPersianDigits(order.reference)}`}
                >
                  {Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* DNS checklist + live preview                                        */
/* ------------------------------------------------------------------ */

function DnsChecklistCard({
  status,
  loading,
  onCheck,
  baseUrl,
  currentDomain,
  onEditDomain,
}: {
  status: CmsDnsStatus | null;
  loading: boolean;
  onCheck: () => void;
  baseUrl: string;
  currentDomain: string;
  onEditDomain: () => void;
}) {
  const domainActions = (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="px-4" onClick={onEditDomain}>
        <PencilIcon className="size-4" />
        تغییر دامنه
      </Button>
      <SecondaryButton onClick={onCheck} disabled={loading}>
        <RefreshCwIcon className="size-4" />
        {loading ? "در حال بررسی…" : "بررسی DNS"}
      </SecondaryButton>
    </div>
  );

  if (!status) {
    return (
      <SectionCard title="دامنه و انتشار سایت" description={`دامنهٔ فعلی: ${currentDomain}`}>
        {loading ? (
          <LoadingSkeleton rows={3} compact label="در حال بررسی وضعیت DNS" />
        ) : (
          <EmptyState>برای بررسی، «بررسی DNS» را بزنید.</EmptyState>
        )}
        <div className="mt-3">{domainActions}</div>
      </SectionCard>
    );
  }

  const steps = [
    { done: status.dns.resolved, label: `رکورد DNS برای «${status.dns.cmsHost}» ساخته شود (A/CNAME)` },
    { done: status.dns.pointingToCms, label: `دامنه به سرور CMS اشاره کند (${status.dns.cmsHost})` },
    { done: Boolean(status.domainVerified), label: "در پنل CMS مدیریت سایت → تأیید دامنه روشن شود" },
  ];

  return (
    <SectionCard
      title="دامنه و انتشار سایت"
      description={`دامنهٔ فعلی: ${currentDomain} — هر گام سبز شده یعنی آن بخش انجام شده است.`}
      actions={domainActions}
    >
      <ol className="space-y-2">
        {steps.map((step) => (
          <li key={step.label} className="flex items-start gap-2.5 text-sm">
            {step.done ? (
              <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <span className="mt-1 size-2 shrink-0 rounded-full bg-amber-400 dark:bg-amber-400" />
            )}
            <span className={step.done ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-foreground"}>
              {step.label}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 rounded-xl bg-muted px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        {cmsDnsHint(status)}
      </p>
      <div className="mt-3">
        <Button type="button" variant="outline" className="px-4" onClick={() => window.open(`${baseUrl}/admin`, "_blank", "noopener")}>
          <ExternalLinkIcon className="size-4" />
          باز کردن مدیریت CMS
        </Button>
      </div>
    </SectionCard>
  );
}

function PreviewCard({
  status,
  ready,
  frameKey,
  onLoad,
  onRefresh,
}: {
  status: CmsDnsStatus | null;
  ready: boolean;
  frameKey: number;
  onLoad: () => void;
  onRefresh: () => void;
}) {
  const live = Boolean(status?.dns.resolved && status?.dns.pointingToCms && status?.domainVerified);
  const url = status?.previewUrl ?? "#";

  return (
    <SectionCard
      title="پیش‌نمایش سایت"
      description="سایت واقعی، همان‌طور که بازدیدکننده می‌بیند."
      actions={
        <div className="flex gap-2">
          {live ? (
            <SecondaryButton onClick={onRefresh}>
              <RefreshCwIcon className="size-4" />
              بارگذاری مجدد
            </SecondaryButton>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="px-4"
            onClick={() => window.open(url, "_blank", "noopener")}
          >
            <ExternalLinkIcon className="size-4" />
            باز کردن سایت
          </Button>
        </div>
      }
    >
      {!live ? (
        <div className="space-y-2">
          <EmptyState>
            {status
              ? "برای فعال‌شدن پیش‌نمایش، مراحل «دامنه و انتشار سایت» را کامل کنید (DNS + تأیید دامنه)."
              : "برای فعال‌شدن پیش‌نمایش، اتصال را بررسی کنید."}
          </EmptyState>
          <p className="text-xs leading-5 text-muted-foreground">
            پیش‌نمایش از همان دامنهٔ سایت بارگذاری می‌شود، پس تا وقتی DNS و تأیید کامل نشده‌اند باز نمی‌شود. برای
            اجازهٔ جاسازی، خاستگاه این پنل باید در متغیر <code dir="ltr">SITE_PREVIEW_ORIGINS</code> سرور CMS باشد.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <div dir="ltr" className="flex items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <ShieldCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            <span className="truncate">{url}</span>
          </div>
          {/* key remounts the frame on refresh so the page reloads cleanly */}
          <div className="relative h-[560px]">
            {!ready ? (
              <div
                role="status"
                aria-live="polite"
                aria-busy="true"
                aria-label="در حال بارگذاری پیش‌نمایش سایت"
                className="absolute inset-0 z-10 bg-card p-4"
              >
                <Skeleton aria-hidden="true" className="h-full w-full rounded-xl" />
              </div>
            ) : null}
            <iframe
              key={frameKey}
              src={url}
              title="پیش‌نمایش سایت"
              className={`h-full w-full bg-card transition-opacity motion-reduce:transition-none ${ready ? "opacity-100" : "opacity-0"}`}
              onLoad={onLoad}
            />
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Posts, products and domain — create/edit/delete dialogs             */
/* ------------------------------------------------------------------ */

export function PostDialog({
  post,
  onClose,
  onSaved,
}: {
  post: CmsPost | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(post?.title ?? "");
  const [content, setContent] = useState(lexicalToPlainText(post?.content));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      post ? `/api/cms/website/posts/${post.id}` : "/api/cms/website/posts",
      { method: post ? "PATCH" : "POST", body: JSON.stringify({ title: title.trim(), content }) },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success(post ? "نوشته ذخیره شد." : "نوشته ساخته شد.");
    onSaved();
  };

  const remove = async () => {
    if (!post || !window.confirm(`«${post.title}» حذف شود؟`)) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/cms/website/posts/${post.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("نوشته حذف شد.");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{post ? `ویرایش نوشته` : "نوشتهٔ جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="عنوان">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="متن نوشته" hint="هر خط، یک پاراگراف می‌شود. برای قالب‌بندی پیشرفته از پنل CMS استفاده کنید.">
          <textarea className={inputClass} rows={8} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>

        <DialogFooter>
          {post ? (
            <Button
              type="button"
              variant="ghost"
              onClick={remove}
              disabled={busy}
              className="me-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              حذف
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ProductDialog({
  product,
  currency,
  onClose,
  onSaved,
}: {
  product: CmsProduct | null;
  currency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(product?.title ?? "");
  const [summary, setSummary] = useState(product?.summary ?? "");
  const [price, setPrice] = useState(product ? String(product.price) : "");
  const [sku, setSku] = useState(product?.sku ?? "");
  const [trackInventory, setTrackInventory] = useState(Boolean(product?.trackInventory));
  const [inventory, setInventory] = useState(product?.inventory !== undefined && product?.inventory !== null ? String(product.inventory) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>(
      product ? `/api/cms/website/products/${product.id}` : "/api/cms/website/products",
      {
        method: product ? "PATCH" : "POST",
        body: JSON.stringify({
          title: title.trim(),
          summary: summary.trim() || undefined,
          price: Number(toLatinDigits(price).replace(/[^\d]/g, "")) || 0,
          sku: sku.trim() || undefined,
          trackInventory,
          inventory: trackInventory ? Number(toLatinDigits(inventory).replace(/[^\d]/g, "")) || 0 : undefined,
        }),
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success(product ? "محصول ذخیره شد." : "محصول ساخته شد.");
    onSaved();
  };

  const remove = async () => {
    if (!product || !window.confirm(`«${product.title}» حذف شود؟`)) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/cms/website/products/${product.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("محصول حذف شد.");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{product ? "ویرایش محصول" : "محصول جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="عنوان">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="توضیح کوتاه (اختیاری)">
          <textarea className={inputClass} rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <Field label={`قیمت (${currency})`}>
          <input
            className={inputClass}
            value={toPersianDigits(price)}
            onChange={(e) => setPrice(toLatinDigits(e.target.value).replace(/[^\d]/g, ""))}
          />
        </Field>
        <Field label="کد کالا (اختیاری)">
          <input className={inputClass} dir="ltr" value={sku} onChange={(e) => setSku(e.target.value)} />
        </Field>
        <label className="mb-3 flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={trackInventory}
            onChange={(e) => setTrackInventory(e.target.checked)}
            className="size-4 rounded border-input"
          />
          موجودی را بشمار
        </label>
        {trackInventory ? (
          <Field label="موجودی">
            <input
              className={inputClass}
              value={toPersianDigits(inventory)}
              onChange={(e) => setInventory(toLatinDigits(e.target.value).replace(/[^\d]/g, ""))}
            />
          </Field>
        ) : null}

        <DialogFooter>
          {product ? (
            <Button
              type="button"
              variant="ghost"
              onClick={remove}
              disabled={busy}
              className="me-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              حذف
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DomainDialog({
  currentDomain,
  onClose,
  onSaved,
}: {
  currentDomain: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [domain, setDomain] = useState(currentDomain);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/cms/website/domain", {
      method: "PATCH",
      body: JSON.stringify({ domain: domain.trim() }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessageOrRaw(data.error));
      return;
    }
    toast.success("دامنه تغییر کرد؛ حالا باید دوباره تأیید شود.");
    onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>تغییر دامنه</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          پس از تغییر، وضعیت «تأیید دامنه» بازنشانی می‌شود و باید دوباره DNS تنظیم و در پنل CMS تأیید شود.
        </p>
        <Field label="دامنهٔ جدید" hint="فقط میزبان — مثل acme.ir">
          <input className={inputClass} dir="ltr" value={domain} onChange={(e) => setDomain(e.target.value)} />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
