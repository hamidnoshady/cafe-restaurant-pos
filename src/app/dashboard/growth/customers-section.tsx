"use client";

/**
 * Growth's customer data view.
 *
 * The customer record is owned by CRM. Growth does not create a second customer
 * table or a second edit path; it reads the shared customer service so campaign
 * and loyalty work with the same person Accounting and Sales see. A link on
 * each row leads to the CRM when a user needs to change the canonical record.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ContactIcon, ExternalLinkIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { crmCustomerHref, crmSectionHref } from "../crm/crm-routes";
import { cardClass, EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "../page-chrome";
import { api, ErrorBox, inputClass } from "../ui";

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  isActive: boolean;
}

/** A read-only projection for Growth; edits stay in CRM. */
export function GrowthCustomersSection({ selectedCustomerId }: { selectedCustomerId?: string }) {
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      // Only the customers, from the shared party table: Growth's member list is
      // not the CRM's directory, and since Phase «parties» that table also holds
      // the suppliers and the staff.
      const params = new URLSearchParams({ page: "1", pageSize: "100", roles: "Customer" });
      if (query.trim()) params.set("q", query.trim());
      api<{ customers: Customer[] }>(`/api/parties?${params}`).then(({ ok, data }) => {
        if (ok) {
          setCustomers(data.customers);
          setError("");
        } else {
          setCustomers([]);
          setError("بارگذاری مشتریان ممکن نشد.");
        }
      });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  // A/R can deep-link to a customer that is outside the first directory page
  // (or archived). Fetch that one shared record so the Growth destination
  // always makes the hand-off visible instead of silently opening an unrelated
  // slice of the customer list.
  useEffect(() => {
    if (!selectedCustomerId || customers === null || customers.some((customer) => customer.id === selectedCustomerId)) return;
    api<{ customer: Customer }>(`/api/parties/${encodeURIComponent(selectedCustomerId)}`).then(({ ok, data }) => {
      if (ok) {
        setCustomers((current) =>
          current && current.every((customer) => customer.id !== selectedCustomerId)
            ? [data.customer, ...current]
            : current,
        );
      }
    });
  }, [customers, selectedCustomerId]);

  if (customers === null) return <SectionCardSkeleton rows={5} />;

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مشتریان وفادار</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">مشتریان</h2>
          </div>
        }
        description="این نمای رشد از پروندهٔ مشترک مشتریان می‌خواند؛ ویرایش و پروندهٔ کامل در CRM انجام می‌شود."
        actions={
          <Link
            href={crmSectionHref("directory")}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            مدیریت در CRM
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Link>
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
          <ul className={`${cardClass} mt-4 divide-y divide-border/80 overflow-hidden`}>
            {customers.map((customer) => (
              <li
                key={customer.id}
                className={`flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5 ${
                  customer.id === selectedCustomerId ? "bg-amber-50 dark:bg-amber-500/10" : ""
                }`}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">
                  <ContactIcon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <Link
                    href={crmCustomerHref(customer.id)}
                    className="font-medium text-foreground hover:underline"
                  >
                    {customer.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {customer.phone ? toPersianDigits(customer.phone) : "بدون شمارهٔ تماس"}
                    {customer.address ? ` · ${customer.address}` : ""}
                  </p>
                </div>
                <StatusBadge tone={customer.isActive ? "positive" : "neutral"}>
                  {customer.isActive ? "فعال" : "آرشیو"}
                </StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
