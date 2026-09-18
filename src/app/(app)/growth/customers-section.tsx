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
import { useEffect, useState } from "react";
import Link from "next/link";
import { ContactIcon } from "lucide-react";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { LIFECYCLE_STAGES, type LifecycleStage } from "@/lib/crm-scoring";
import { partyScopeFor } from "@/lib/parties-scopes";
import type { GrowthCustomer } from "@/app/api/growth/customers/route";
import { Button } from "@/components/ui/button";
import { crmCustomerHref } from "@/app/(app)/crm/crm-routes";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
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

function stageLabel(stage: string | null): string {
  if (!stage) return "—";
  return LIFECYCLE_STAGES[stage as LifecycleStage]?.label ?? stage;
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
  const [businessId, setBusinessId] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState<{ partyId?: string } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      api<{ customers: GrowthCustomer[]; businessId?: string }>(`/api/growth/customers?${params}`).then(
        ({ ok, data }) => {
          if (ok) {
            setCustomers(data.customers ?? []);
            setBusinessId(data.businessId ?? "");
            setError("");
          } else {
            setCustomers([]);
            setError("بارگذاری مشتریان ممکن نشد.");
          }
        },
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query, refreshKey]);

  // A/R used to deep-link into this projection by `selectedCustomerId`. The
  // projection is paginated at the source, so a linked customer may be outside
  // the first page; fetch that one shared record and prepend it so the hand-off
  // still lands on the person they meant.
  useEffect(() => {
    if (!selectedCustomerId || customers === null || customers.some((customer) => customer.id === selectedCustomerId)) return;
    api<{ customers: GrowthCustomer[] }>(`/api/growth/customers?id=${encodeURIComponent(selectedCustomerId)}`).then(
      ({ ok, data }) => {
        if (ok) {
          const target = data.customers?.find((customer) => customer.id === selectedCustomerId);
          if (target) {
            setCustomers((current) =>
              current && current.every((customer) => customer.id !== selectedCustomerId)
                ? [target, ...current]
                : current,
            );
          }
        }
      },
    );
  }, [customers, selectedCustomerId]);

  if (customers === null) return <SectionCardSkeleton rows={5} />;

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مشتریان وفادار</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">مشتریان</h2>
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
        <label className="block max-w-sm">
          <span className="mb-1 block text-xs font-semibold text-muted-foreground">جست‌وجوی مشتری</span>
          <input
            className={inputClass}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="جستجو با نام یا تلفن…"
          />
        </label>

        {customers.length === 0 ? (
          <EmptyState>مشتری‌ای پیدا نشد.</EmptyState>
        ) : (
          <>
            <DataTable caption="فهرست مشتریان باشگاه" className="hidden lg:block">
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
                {customers.map((customer) => (
                  <DataTableRow key={customer.id} selected={customer.id === selectedCustomerId}>
                    <Td>
                      <Link
                        href={crmCustomerHref(customer.id)}
                        className="inline-flex items-center gap-2 font-medium text-foreground hover:underline"
                      >
                        <ContactIcon className="size-4 shrink-0 text-teal-700 dark:text-teal-300" aria-hidden="true" />
                        {customer.displayName}
                      </Link>
                    </Td>
                    <Td muted>{customer.phone ? toPersianDigits(customer.phone) : "—"}</Td>
                    <Td>{stageLabel(customer.lifecycleStage)}</Td>
                    <Td numeric>{formatPersianNumber(customer.orderCount)}</Td>
                    <Td numeric className="font-semibold">
                      {money.format(customer.totalSpentRial)}
                    </Td>
                    <Td numeric>{formatPersianNumber(customer.points)}</Td>
                    <Td>
                      <StatusBadge tone={customer.isActive ? "positive" : "neutral"}>
                        {customer.isActive ? "فعال" : "آرشیو"}
                      </StatusBadge>
                    </Td>
                    {canManage ? (
                      <Td>
                        <Button type="button" variant="ghost" size="xs" onClick={() => setForm({ partyId: customer.id })}>
                          ویرایش
                        </Button>
                      </Td>
                    ) : null}
                  </DataTableRow>
                ))}
              </DataTableBody>
            </DataTable>

            <div className="space-y-3 lg:hidden">
              {customers.map((customer) => (
                <article
                  key={customer.id}
                  className={`rounded-xl border border-border/80 bg-muted/50 p-4 ${customer.id === selectedCustomerId ? "border-amber-300 dark:border-amber-500/40" : ""}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link href={crmCustomerHref(customer.id)} className="inline-flex items-center gap-2 font-semibold text-foreground hover:underline">
                        <ContactIcon className="size-4 shrink-0 text-teal-700 dark:text-teal-300" aria-hidden="true" />
                        {customer.displayName}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">{customer.phone ? toPersianDigits(customer.phone) : "شماره‌ای ثبت نشده"}</p>
                    </div>
                    <StatusBadge tone={customer.isActive ? "positive" : "neutral"}>
                      {customer.isActive ? "فعال" : "آرشیو"}
                    </StatusBadge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border/80 pt-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">مرحلهٔ چرخهٔ حیات</dt>
                      <dd className="mt-1 font-medium">{stageLabel(customer.lifecycleStage)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">امتیاز وفاداری</dt>
                      <dd className="mt-1 font-medium tabular-nums">{formatPersianNumber(customer.points)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">خریدها</dt>
                      <dd className="mt-1 font-medium tabular-nums">{formatPersianNumber(customer.orderCount)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">مجموع خرید</dt>
                      <dd className="mt-1 font-medium tabular-nums">{money.format(customer.totalSpentRial)}</dd>
                    </div>
                  </dl>
                  {canManage ? (
                    <div className="mt-3 border-t border-border/80 pt-2">
                      <Button type="button" variant="ghost" size="xs" onClick={() => setForm({ partyId: customer.id })}>
                        ویرایش
                      </Button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </>
        )}
      </SectionCard>

      {form ? (
        <PartyFormDialog
          scope={partyScopeFor("growth")}
          partyId={form.partyId ?? null}
          businessId={businessId}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setInfo("مشتری ذخیره شد.");
            setRefreshKey((key) => key + 1);
          }}
        />
      ) : null}
    </div>
  );
}
