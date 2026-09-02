"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The Website Manager (issue #378) — «وب‌سایت» under Growth & Marketing.
 *
 * Half connection form, half management surface, both over the headless CMS
 * API (`src/lib/cms/`). The browser never sees a CMS key: connect/provision
 * POST the credential once, the server stores it encrypted (migration 0122)
 * and every later call uses the stored site key server-side.
 *
 * Connected state is one overview call: the site's descriptor (theme,
 * locales, store currency), its pages, its catalogue and its orders.
 * Order status changes are the one e-commerce write here — back on the CMS
 * their own hooks settle stock and snapshot the change.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheckIcon, ExternalLinkIcon, GlobeIcon, PlugZapIcon, RefreshCwIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import type { CmsConnectionSummary } from "@/lib/cms/connections";
import type { CmsOrder, SiteDescriptor } from "@/lib/cms/types";
import { Skeleton } from "@/components/ui/skeleton";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { api, errorMessageOrRaw, Field, inputClass, PrimaryButton, SecondaryButton, ErrorBox } from "../ui";
import { cmsDnsHint } from "@/lib/cms/dns";
import type { CmsDnsStatus, WebsiteOverview } from "@/lib/cms/website-service";

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

type Mode = "connect" | "provision";

export function WebsiteSection() {
  const [connection, setConnection] = useState<CmsConnectionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("connect");
  const [overview, setOverview] = useState<WebsiteOverview | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [busy, setBusy] = useState(false);
  const [updatingOrder, setUpdatingOrder] = useState("");
  const [dnsStatus, setDnsStatus] = useState<CmsDnsStatus | null>(null);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

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
          checkDns();
        } else {
          setOverview(null);
          setDnsStatus(null);
        }
      },
    );
  }, [loadOverview, checkDns]);

  useEffect(reload, [reload]);

  if (loading) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  if (!connection) {
    return (
      <ConnectPanel
        mode={mode}
        setMode={setMode}
        busy={busy}
        setBusy={setBusy}
        onDone={() => {
          toast.success("وب‌سایت متصل شد.");
          reload();
        }}
      />
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="اتصال به سایت"
        description={`${connection.siteDomain} — محتوای سایت و فروشگاه از CMS پلتفرم خوانده می‌شود.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <SecondaryButton onClick={reload} disabled={busy}>
              <RefreshCwIcon className="size-4" />
              بروزرسانی
            </SecondaryButton>
            <Button
              type="button"
              variant="outline"
              className="px-4"
              onClick={() => window.open(`${connection.baseUrl}/admin`, "_blank", "noopener")}
            >
              <ExternalLinkIcon className="size-4" />
              مدیریت محتوا در CMS
            </Button>
            <Button
              type="button"
              variant="outline"
              className="px-4 text-destructive hover:text-destructive"
              onClick={() => {
                if (!window.confirm("قطع اتصال؟ سایت و محتوای آن روی CMS می‌ماند؛ فقط این اتصال برداشته می‌شود.")) return;
                setBusy(true);
                api("/api/cms/website/connection", { method: "DELETE" }).then(() => {
                  setBusy(false);
                  toast.success("اتصال برداشته شد.");
                  reload();
                });
              }}
            >
              <Trash2Icon className="size-4" />
              قطع اتصال
            </Button>
          </div>
        }
      >
        <ErrorBox>{overviewError}</ErrorBox>
        {overview ? (
          <SiteSummary site={overview.site} />
        ) : (
          <p className="text-sm text-muted-foreground">اتصال برقرار است؛ برای بارگذاری محتوا بروزرسانی را بزنید.</p>
        )}
      </SectionCard>

      <DnsChecklistCard
        status={dnsStatus}
        loading={dnsLoading}
        onCheck={checkDns}
        baseUrl={connection.baseUrl}
      />

      <PreviewCard
        status={dnsStatus}
        ready={previewReady}
        frameKey={previewKey}
        onLoad={() => setPreviewReady(true)}
        onRefresh={() => {
          setPreviewReady(false);
          setPreviewKey((key) => key + 1);
        }}
      />

      {overview ? (
        <>
          <SectionCard title="صفحه‌ها" description="صفحه‌های منتشرشدهٔ سایت (۲۰ صفحهٔ آخر).">
            {overview.pages.length === 0 ? (
              <EmptyState>هنوز صفحه‌ای ساخته نشده است.</EmptyState>
            ) : (
              <ul className="divide-y divide-border">
                {overview.pages.map((page) => (
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

          <SectionCard title="محصولات" description="فروشگاه آنلاین (۵۰ محصول آخر).">
            {overview.products.length === 0 ? (
              <EmptyState>فروشگاه هنوز محصولی ندارد.</EmptyState>
            ) : (
              <ul className="divide-y divide-border">
                {overview.products.map((product) => (
                  <li key={product.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{product.title}</p>
                      {product.sku ? <p className="truncate text-xs text-muted-foreground">{product.sku}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <p className="text-sm font-semibold text-foreground">
                        {formatPersianNumber(product.price)}{" "}
                        <span className="text-xs font-normal text-muted-foreground">
                          {CURRENCY_LABELS[overview.site.store.currency] ?? overview.site.store.currency}
                        </span>
                      </p>
                      <StatusBadge tone={product._status === "published" ? "positive" : "active"}>
                        {STATUS_LABELS[product._status ?? "draft"]}
                      </StatusBadge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <OrdersCard
            orders={overview.orders}
            currency={overview.site.store.currency}
            updatingOrder={updatingOrder}
            onStatusChange={(order, status) => {
              setUpdatingOrder(order.id);
              api<{ order: CmsOrder }>(`/api/cms/website/orders/${order.id}`, {
                method: "PATCH",
                body: JSON.stringify({ status }),
              }).then(({ ok, data }) => {
                if (ok) {
                  setOverview((current) =>
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
        </>
      ) : null}
    </div>
  );
}

function SiteSummary({ site }: { site: SiteDescriptor }) {
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
}: {
  status: CmsDnsStatus | null;
  loading: boolean;
  onCheck: () => void;
  baseUrl: string;
}) {
  if (!status) {
    return (
      <SectionCard title="دامنه و انتشار سایت" description="سه قدم تا فعال‌شدن سایت روی اینترنت.">
        {loading ? (
          <LoadingSkeleton rows={3} compact label="در حال بررسی وضعیت DNS" />
        ) : (
          <EmptyState>برای بررسی، «بررسی DNS» را بزنید.</EmptyState>
        )}
        <div className="mt-3">
          <SecondaryButton onClick={onCheck} disabled={loading}>
            <RefreshCwIcon className="size-4" />
            {loading ? "در حال بررسی…" : "بررسی DNS"}
          </SecondaryButton>
        </div>
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
      description="هر گام سبز شده یعنی آن بخش انجام شده است."
      actions={
        <SecondaryButton onClick={onCheck} disabled={loading}>
          <RefreshCwIcon className="size-4" />
          {loading ? "در حال بررسی…" : "بررسی DNS"}
        </SecondaryButton>
      }
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
/* Not connected: connect an existing site, or provision a new one     */
/* ------------------------------------------------------------------ */

function ConnectPanel({
  mode,
  setMode,
  busy,
  setBusy,
  onDone,
}: {
  mode: Mode;
  setMode: (mode: Mode) => void;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [siteDomain, setSiteDomain] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyName, setKeyName] = useState("");
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [type, setType] = useState<"business" | "portfolio" | "store">("business");
  const [error, setError] = useState("");

  const submitConnect = () => {
    setBusy(true);
    setError("");
    api("/api/cms/website/connect", {
      method: "POST",
      body: JSON.stringify({ baseUrl, siteDomain, apiKey, keyName: keyName || undefined }),
    })
      .then(({ ok, data }) => {
        if (ok) onDone();
        else setError(errorMessageOrRaw((data as { error?: string }).error));
      })
      .finally(() => setBusy(false));
  };

  const submitProvision = () => {
    setBusy(true);
    setError("");
    api("/api/cms/website/provision", {
      method: "POST",
      body: JSON.stringify({ name, domain, type }),
    })
      .then(({ ok, data }) => {
        if (ok) onDone();
        else setError(errorMessageOrRaw((data as { error?: string }).error));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="وب‌سایت اینترنتی"
        description={
          mode === "connect"
            ? "اتصال به سایتی که روی پلتفرم Eshobe ساخته‌اید."
            : "ساخت سایت جدید روی پلتفرم و اتصال خودکار."
        }
      >
        <div className="mb-4 flex gap-2">
          <Button type="button" variant={mode === "connect" ? "default" : "outline"} onClick={() => setMode("connect")}>
            <PlugZapIcon className="size-4" />
            اتصال سایت موجود
          </Button>
          <Button type="button" variant={mode === "provision" ? "default" : "outline"} onClick={() => setMode("provision")}>
            <GlobeIcon className="size-4" />
            ساخت سایت جدید
          </Button>
        </div>

        <ErrorBox>{error}</ErrorBox>

        {mode === "connect" ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitConnect();
            }}
          >
            <Field label="آدرس سرور CMS" hint="آدرس کنترل پین پلتفرم — بدون اسلش پایانی.">
              <input
                className={inputClass}
                dir="ltr"
                placeholder="https://cms.eshobe.com"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required
              />
            </Field>
            <Field label="دامنهٔ سایت" hint="فقط میزبان — مثل acme.ir">
              <input
                className={inputClass}
                dir="ltr"
                placeholder="acme.ir"
                value={siteDomain}
                onChange={(event) => setSiteDomain(event.target.value)}
                required
              />
            </Field>
            <Field label="کلید API سایت" hint="از بخش کلیدهای API پلتفرم صادر می‌شود و فقط یک‌بار نمایش داده می‌شود.">
              <input
                className={inputClass}
                dir="ltr"
                type="password"
                placeholder="eshobe_live_…"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                required
              />
            </Field>
            <Field label="نام اتصال (اختیاری)">
              <input
                className={inputClass}
                placeholder="پنل مدیریت"
                value={keyName}
                onChange={(event) => setKeyName(event.target.value)}
              />
            </Field>
            <PrimaryButton disabled={busy}>{busy ? "در حال اتصال…" : "اتصال"}</PrimaryButton>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submitProvision();
            }}
          >
            <Field label="نام سایت">
              <input
                className={inputClass}
                placeholder="فروشگاه اصفهان"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </Field>
            <Field label="دامنهٔ سایت" hint="پس از ساخت، DNS را به سرور CMS اشاره دهید.">
              <input
                className={inputClass}
                dir="ltr"
                placeholder="shop.esfahan.ir"
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                required
              />
            </Field>
            <Field label="نوع سایت">
              <select className={inputClass} value={type} onChange={(event) => setType(event.target.value as typeof type)}>
                <option value="business">کسب‌وکار</option>
                <option value="portfolio">نمونه‌کار</option>
                <option value="store">فروشگاه</option>
              </select>
            </Field>
            <PrimaryButton disabled={busy}>{busy ? "در حال ساخت…" : "ساخت و اتصال"}</PrimaryButton>
          </form>
        )}
      </SectionCard>
    </div>
  );
}
