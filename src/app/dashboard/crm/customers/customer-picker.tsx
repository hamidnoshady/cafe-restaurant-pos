"use client";

/**
 * Search-and-open for the customer file (Phase 36).
 *
 * Deliberately thin: it reuses `/api/customers?q=` — the same search the POS's
 * credit-payment picker calls — rather than adding a CRM-specific lookup, so
 * there is one definition of "find a customer by what someone typed".
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { formatPhoneDisplay } from "@/lib/phone";
import { EmptyState } from "../../page-chrome";
import { api, inputClass } from "../../ui";
import { crmCustomerHref } from "../crm-routes";

interface Match {
  id: string;
  name: string;
  phone: string | null;
}

export function CustomerPicker({ directoryHref }: { directoryHref: string }) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[] | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setMatches(null);
      return;
    }
    const timer = setTimeout(() => {
      api<{ customers: Match[] }>(`/api/customers?q=${encodeURIComponent(query.trim())}`).then(
        ({ ok, data }) => {
          if (ok) setMatches(data.customers);
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  return (
    <div className="space-y-3">
      <input
        className={inputClass}
        placeholder="جستجو با نام یا تلفن…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
      />

      {matches === null ? (
        <p className="text-xs text-muted-foreground">
          حداقل دو نویسه بنویسید. برای مدیریت فهرست کامل،{" "}
          <Link href={directoryHref} className="underline">
            فهرست مشتریان
          </Link>{" "}
          را باز کنید.
        </p>
      ) : matches.length === 0 ? (
        <EmptyState>مشتری‌ای با این مشخصات پیدا نشد.</EmptyState>
      ) : (
        <ul className="divide-y divide-stone-200/80 text-sm">
          {matches.map((match) => (
            <li key={match.id} className="py-2.5">
              <Link href={crmCustomerHref(match.id)} className="hover:underline">
                <span className="font-medium text-stone-950">{match.name}</span>
                {match.phone ? (
                  <span className="mr-2 text-xs text-muted-foreground">
                    {toPersianDigits(formatPhoneDisplay(match.phone))}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
