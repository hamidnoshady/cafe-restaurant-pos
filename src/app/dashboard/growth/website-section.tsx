"use client";

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

import { useCallback, useEffect, useState } from "react";
import { ExternalLinkIcon, GlobeIcon, PlugZapIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import type { CmsConnectionSummary } from "@/lib/cms/connections";
import type { CmsOrder, SiteDescriptor } from "@/lib/cms/types";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { api, errorMessageOrRaw, Field, inputClass, PrimaryButton, SecondaryButton, ErrorBox } from "../ui";
import type { WebsiteOverview } from "@/lib/cms/website-service";

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

  const reload = useCallback(() => {
    setLoading(true);
    api<{ connected: boolean; connection: CmsConnectionSummary | null }>("/api/cms/website/state").then(
      ({ ok, data }) => {
        setLoading(false);
        if (!ok) return;
        setConnection(data.connection);
        if (data.connection) loadOverview();
        else setOverview(null);
      },
    );
  }, [loadOverview]);

  useEffect(reload, [reload]);

  if (loading) {
    return (
      <div aria-live="polite" className={`px-5 py-6 text-sm text-stone-500 ${cardClass}`}>
        در حال بارگذاری…
      </div>
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

      {overview ? (
        <>
          <SectionCard title="صفحه‌ها" description="صفحه‌های منتشرشدهٔ سایت (۲۰ صفحهٔ آخر).">
            {overview.pages.length === 0 ? (
              <EmptyState>هنوز صفحه‌ای ساخته نشده است.</EmptyState>
            ) : (
              <ul className="divide-y divide-stone-100">
                {overview.pages.map((page) => (
                  <li key={page.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-950">{page.title}</p>
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
              <ul className="divide-y divide-stone-100">
                {overview.products.map((product) => (
                  <li key={product.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-950">{product.title}</p>
                      {product.sku ? <p className="truncate text-xs text-muted-foreground">{product.sku}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <p className="text-sm font-semibold text-stone-950">
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
        <p className="mt-0.5 truncate text-sm font-medium text-stone-950">{site.name}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">دامنه</p>
        <p dir="ltr" className="mt-0.5 truncate text-sm font-medium text-stone-950">
          {site.domain}
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">نوع و وضعیت</p>
        <p className="mt-0.5 flex items-center gap-2 text-sm font-medium text-stone-950">
          {TYPE_LABELS[site.type] ?? site.type}
          <StatusBadge tone={site.status === "active" ? "positive" : site.status === "suspended" ? "active" : "neutral"}>
            {STATUS_LABELS[site.status] ?? site.status}
          </StatusBadge>
        </p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">زبان‌ها و ارز</p>
        <p className="mt-0.5 text-sm font-medium text-stone-950">
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
        <ul className="divide-y divide-stone-100">
          {orders.map((order) => (
            <li key={order.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-stone-950">
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
                placeholder="کافه اصفهان"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </Field>
            <Field label="دامنهٔ سایت" hint="پس از ساخت، DNS را به سرور CMS اشاره دهید.">
              <input
                className={inputClass}
                dir="ltr"
                placeholder="cafe.esfahan.ir"
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
