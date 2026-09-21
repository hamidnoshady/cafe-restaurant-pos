"use client";

/**
 * Growth's customer view.
 *
 * The customer *row* is the shared `parties` record — Growth keeps no second
 * customer table. What makes this *Growth's* screen rather than Accounting's or
 * CRM's is the columns it answers against (lifecycle/RFM stage, loyalty points
 * and purchase history, not ledger codes and tax rates) and the fact that it is
 * managed here: adding and editing open the same party form every other app
 * writes with, so a name fixed here is fixed everywhere. Only the 360° file
 * (notes, tags, timeline) lives in the CRM, and the customer name links to it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ContactIcon } from "lucide-react";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { LIFECYCLE_STAGES, type LifecycleStage } from "@/lib/crm-scoring";
import { partyScopeFor } from "@/lib/parties-scopes";
import type { GrowthCustomer } from "@/app/api/growth/customers/route";
import { Button } from "@/components/ui/button";
import { crmCustomerHref } from "@/app/(app)/crm/crm-routes";
import {
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { PartyFormDialog } from "@/app/dashboard/parties/party-form";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { api, ErrorBox, InfoBox, inputClass } from "@/app/dashboard/ui";

const PAGE_SIZE = 50;

function stageLabel(stage: string | null): string {
  if (!stage) return "—";
  return LIFECYCLE_STAGES[stage as LifecycleStage]?.label ?? stage;
}

/** A stage's badge tone, so the table reads at a glance the way the CRM's does. */
function stageTone(
  stage: string | null,
): "active" | "positive" | "neutral" | "danger" {
  if (!stage) return "neutral";
  return LIFECYCLE_STAGES[stage as LifecycleStage]?.tone ?? "neutral";
}

/** A purchase date is a business day (`YYYY-MM-DD`), shown in Jalali like every other date. */
function purchaseDate(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return toPersianDigits(formatJalali(parsed));
}

interface CustomersResponse {
  customers?: GrowthCustomer[];
  total?: number;
  businessId?: string;
}

/** Growth's own customers screen: its columns, its add/edit, the shared record. */
export function GrowthCustomersSection({
  selectedCustomerId,
  role,
}: {
  selectedCustomerId?: string;
  role: string;
}) {
  const money = useMoney();
  // The page admits owner/manager/accountant; all three hold `parties.manage`,
  // so the buttons below are drawn for everyone who can open this screen.
  const canManage = ["owner", "manager", "accountant"].includes(role);

  const [customers, setCustomers] = useState<GrowthCustomer[] | null>(null);
  const [pinned, setPinned] = useState<GrowthCustomer | null>(null);
  const [total, setTotal] = useState(0);
  const [businessId, setBusinessId] = useState("");
  const [query, setQuery] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  // `loading` is *not* the same state as `customers === null`: the first read
  // gets a skeleton, but a re-read triggered by typing must keep the rows on
  // screen and merely dim them, or the list flickers away under every keystroke.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState<{ partyId?: string } | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Typing a new search while sitting on page 4 must not ask for page 4 of a
  // different, shorter result set — which answered with an empty screen.
  useEffect(() => {
    setPage(1);
  }, [query, includeInactive]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (includeInactive) params.set("includeInactive", "1");
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      void api<CustomersResponse>(`/api/growth/customers?${params}`, {
        signal: controller.signal,
      }).then(({ ok, data, aborted }) => {
        // A superseded request has nobody left to report to: writing its result
        // would overwrite the newer search's rows with the older search's.
        if (aborted) return;
        setLoading(false);
        if (ok) {
          setCustomers(data.customers ?? []);
          setTotal(Number(data.total ?? 0));
          setBusinessId(data.businessId ?? "");
          setError("");
        } else {
          // The rows already on screen are now stale and unexplained; clearing
          // them means the error box is the only thing the screen claims.
          setCustomers([]);
          setTotal(0);
          setError("بارگذاری مشتریان ممکن نشد. دوباره تلاش کنید.");
        }
      });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, includeInactive, page, refreshKey]);

  // A/R deep-links into this projection by `selectedCustomerId`. The projection
  // is paginated, so the linked customer may be outside the current page; fetch
  // that one shared record and pin it to the top so the hand-off still lands on
  // the person they meant.
  //
  // It is kept in its *own* state rather than spliced into `customers`: mutating
  // the list meant the next search re-prepended it, and the effect that did so
  // depended on the very array it wrote, which re-ran it on every list change.
  const fetchedPinFor = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedCustomerId) {
      setPinned(null);
      fetchedPinFor.current = null;
      return;
    }
    // Keyed by refresh too: after a save the pinned copy holds the old name
    // until it is read again.
    const key = `${selectedCustomerId}:${refreshKey}`;
    if (fetchedPinFor.current === key) return;
    fetchedPinFor.current = key;
    const controller = new AbortController();
    void api<CustomersResponse>(
      `/api/growth/customers?id=${encodeURIComponent(selectedCustomerId)}`,
      {
        signal: controller.signal,
      },
    ).then(({ ok, data, aborted }) => {
      if (aborted || !ok) return;
      setPinned(
        data.customers?.find(
          (customer) => customer.id === selectedCustomerId,
        ) ?? null,
      );
    });
    return () => controller.abort();
  }, [selectedCustomerId, refreshKey]);

  // The pinned record is shown once: at the top when this page does not already
  // contain it, in place when it does.
  //
  // `rows` is the *canonical display collection* — both the desktop table and
  // the mobile card list read it. They used to disagree: the table rendered the
  // raw `customers` page while only the phone list rendered `rows`, so a
  // customer deep-linked from Accounting (`?customer=…`) whose record lives on
  // another page of the result set was simply missing on a desktop, while the
  // same URL worked on a phone. Pinned-row logic must have exactly one reader.
  const rows = useMemo(() => {
    const list = customers ?? [];
    if (!pinned || list.some((customer) => customer.id === pinned.id))
      return list;
    return [pinned, ...list];
  }, [customers, pinned]);

  const openEdit = useCallback((partyId: string) => setForm({ partyId }), []);

  if (customers === null) {
    return <SectionCardSkeleton rows={5} label="در حال بارگذاری مشتریان" />;
  }

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{info}</InfoBox>
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
              مشتریان وفادار
            </p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">
              مشتریان
            </h2>
          </div>
        }
        description="این فهرست رشد از پروندهٔ مشترک مشتریان می‌خواند؛ ستون‌ها برای کار رشد‌اند — چرخهٔ حیات، امتیاز و خرید. افزودن و ویرایش در همین بخش انجام می‌شود و پروندهٔ کامل (یادداشت‌ها و تاریخچه) در CRM است."
        actions={
          canManage ? (
            <Button type="button" onClick={() => setForm({})}>
              افزودن مشتری
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="block w-full min-w-0 sm:max-w-sm">
            <span className="mb-1 block text-xs font-semibold text-muted-foreground">
              جست‌وجوی مشتری
            </span>
            <input
              className={inputClass}
              type="search"
              inputMode="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="جستجو با نام یا تلفن…"
              aria-label="جستجو با نام یا تلفن"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-muted-foreground sm:pb-2.5">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            نمایش مشتریان آرشیوشده
          </label>
        </div>

        {/* The count is spoken, so a screen reader hears the search answer rather
            than only sighted users seeing the list change under them. */}
        <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">
          {loading
            ? "در حال جست‌وجو…"
            : total === 0
              ? "نتیجه‌ای نیست."
              : `${formatPersianNumber(total)} مشتری — نمایش ${formatPersianNumber(rangeStart)} تا ${formatPersianNumber(rangeEnd)}`}
        </p>

        {rows.length === 0 ? (
          <EmptyState>
            {query.trim()
              ? "مشتری‌ای با این جست‌وجو پیدا نشد."
              : "هنوز مشتری‌ای ثبت نشده است. با «افزودن مشتری» شروع کنید."}
          </EmptyState>
        ) : (
          <>
            <DataTable
              caption="فهرست مشتریان باشگاه"
              className="hidden lg:block"
            >
              <DataTableHead>
                <Th>مشتری</Th>
                <Th>تلفن</Th>
                <Th>مرحلهٔ چرخهٔ حیات</Th>
                <Th numeric>خریدها</Th>
                <Th numeric>مجموع خرید</Th>
                <Th numeric>امتیاز وفاداری</Th>
                <Th>وضعیت</Th>
                {canManage ? <Th>عملیات</Th> : null}
              </DataTableHead>
              <DataTableBody>
                {rows.map((customer) => (
                  <DataTableRow
                    key={customer.id}
                    selected={customer.id === selectedCustomerId}
                  >
                    <Td>
                      <Link
                        href={crmCustomerHref(customer.id)}
                        className="inline-flex items-center gap-2 font-medium text-foreground hover:underline"
                      >
                        <ContactIcon
                          className="size-4 shrink-0 text-teal-700 dark:text-teal-300"
                          aria-hidden="true"
                        />
                        {customer.displayName}
                      </Link>
                    </Td>
                    <Td muted>
                      {customer.phone ? toPersianDigits(customer.phone) : "—"}
                    </Td>
                    <Td>{stageLabel(customer.lifecycleStage)}</Td>
                    <Td numeric>{formatPersianNumber(customer.orderCount)}</Td>
                    <Td numeric className="font-semibold">
                      {money.format(customer.totalSpentRial)}
                    </Td>
                    <Td numeric>{formatPersianNumber(customer.points)}</Td>
                    <Td>
                      <StatusBadge
                        tone={customer.isActive ? "positive" : "neutral"}
                      >
                        {customer.isActive ? "فعال" : "آرشیو"}
                      </StatusBadge>
                    </Td>
                    {canManage ? (
                      <Td>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => setForm({ partyId: customer.id })}
                        >
                          ویرایش
                        </Button>
                      </Td>
                    ) : null}
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>

            <ul className="space-y-3 lg:hidden">
              {rows.map((customer) => (
                <li key={customer.id}>
                  <article
                    className={`rounded-xl border border-border/80 bg-muted/50 p-4 ${customer.id === selectedCustomerId ? "border-amber-300 dark:border-amber-500/40" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <Link
                          href={crmCustomerHref(customer.id)}
                          className="flex items-center gap-2 font-semibold text-foreground hover:underline"
                        >
                          <ContactIcon
                            className="size-4 shrink-0 text-teal-700 dark:text-teal-300"
                            aria-hidden="true"
                          />
                          {/* A long name must wrap inside the card rather than push
                              the status badge off the edge of a phone screen. */}
                          <span className="min-w-0 break-words">
                            {customer.displayName}
                          </span>
                        </Link>
                        {customer.phone ? (
                          <a
                            href={`tel:${customer.phone}`}
                            dir="ltr"
                            className="mt-1 block text-xs text-muted-foreground hover:underline"
                          >
                            {toPersianDigits(customer.phone)}
                          </a>
                        ) : (
                          <p className="mt-1 text-xs text-muted-foreground">
                            شماره‌ای ثبت نشده
                          </p>
                        )}
                      </div>
                      <StatusBadge
                        tone={customer.isActive ? "positive" : "neutral"}
                      >
                        {customer.isActive ? "فعال" : "آرشیو"}
                      </StatusBadge>
                    </div>
                    <dl className="mt-3 grid gap-2 border-t border-border/80 pt-3 text-sm sm:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">
                          مرحلهٔ چرخهٔ حیات
                        </dt>
                        <dd className="mt-1 font-medium">
                          {stageLabel(customer.lifecycleStage)}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">
                          امتیاز وفاداری
                        </dt>
                        <dd className="mt-1 font-medium tabular-nums">
                          {formatPersianNumber(customer.points)}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">
                          خریدها
                        </dt>
                        <dd className="mt-1 font-medium tabular-nums">
                          {formatPersianNumber(customer.orderCount)}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">
                          مجموع خرید
                        </dt>
                        <dd className="mt-1 font-medium tabular-nums break-words">
                          {money.format(customer.totalSpentRial)}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="text-xs text-muted-foreground">
                          آخرین خرید
                        </dt>
                        <dd className="mt-1 font-medium tabular-nums">
                          {purchaseDate(customer.lastPurchaseDate)}
                        </dd>
                      </div>
                    </dl>
                    {canManage ? (
                      <div className="mt-3 border-t border-border/80 pt-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => openEdit(customer.id)}
                          aria-label={`ویرایش ${customer.displayName}`}
                        >
                          ویرایش
                        </Button>
                      </div>
                    ) : null}
                  </article>
                </li>
              ))}
            </ul>
          </>
        )}

        {totalPages > 1 ? (
          <nav
            aria-label="صفحه‌بندی فهرست مشتریان"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"
          >
            <span>
              صفحهٔ {toPersianDigits(String(page))} از{" "}
              {toPersianDigits(String(totalPages))}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPage((current) => Math.max(current - 1, 1))}
                disabled={page <= 1 || loading}
              >
                قبلی
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setPage((current) => Math.min(current + 1, totalPages))
                }
                disabled={page >= totalPages || loading}
              >
                بعدی
              </Button>
            </div>
          </nav>
        ) : null}
      </SectionCard>

      {form ? (
        <PartyFormDialog
          scope={partyScopeFor("growth")}
          partyId={form.partyId ?? null}
          businessId={businessId}
          onClose={() => setForm(null)}
          onSaved={() => {
            const editing = Boolean(form.partyId);
            setForm(null);
            setInfo(editing ? "تغییرات مشتری ذخیره شد." : "مشتری تازه ثبت شد.");
            // Bumping the key re-reads both the page and the pinned deep-link
            // copy, which would otherwise keep showing the old name.
            setRefreshKey((key) => key + 1);
          }}
        />
      ) : null}
    </div>
  );
}
