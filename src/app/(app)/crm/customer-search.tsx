"use client";

/**
 * The CRM's one «find a customer as you type» control.
 *
 * Four screens needed the same thing — the activity, ticket and deal dialogs
 * attach a record to a customer, the person picker opens a file, the
 * relationships card links two parties — and each had grown its own copy of
 * the same debounced `/api/parties?role=Customer&q=` search. Four copies meant
 * four ways to drift: one dialog searched suppliers and employees too (a deal
 * could be attached to a supplier), one spoke `role=` and another `roles=`,
 * one aborted superseded requests and the others raced them. This file is the
 * single implementation: one query string, one customer-slice search, one
 * 250ms debounce, one abort of whatever a newer keystroke replaced.
 *
 * The search stays scoped to the customer slice on purpose. A ticket, a task
 * or a deal belongs to a *customer* — an unscoped search would offer
 * suppliers and employees as matches, and picking one attaches a person's
 * history to a record type it was never meant to be on.
 */

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, inputClass } from "@/app/dashboard/ui";

/** A directory row as the CRM's pickers need it — name plus what identifies one. */
export interface CustomerSearchMatch {
  id: string;
  name: string;
  phone: string | null;
}

/**
 * Live search over the customer slice of the party directory.
 *
 * - Nothing fires until the query is two characters long: a one-character
 *   search over a whole directory is a request per keystroke that can only
 *   ever return noise.
 * - `enabled: false` parks the search (a dialog whose customer is already
 *   chosen has nothing to look for) and clears whatever it was holding.
 * - `excludeId` removes one party from the results — the relationships card's
 *   "the other end of a link is never this same record" rule.
 * - `searched` distinguishes «not searched yet» from «searched and found
 *   nothing»: silence after a search reads as "still loading", so callers use
 *   it to say so.
 */
export function useCustomerSearch(
  query: string,
  { enabled = true, excludeId }: { enabled?: boolean; excludeId?: string } = {},
): { matches: CustomerSearchMatch[]; searching: boolean; searched: boolean } {
  const trimmed = query.trim();
  const [matches, setMatches] = useState<CustomerSearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (!enabled || trimmed.length < 2) {
      setMatches([]);
      setSearching(false);
      setSearched(false);
      return;
    }
    // Abort, don't flag: a fast typist fires one search per keystroke, and the
    // slow first response must not be allowed to overwrite the last one's.
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ role: "Customer", q: trimmed });
      void api<{ customers?: CustomerSearchMatch[] }>(
        `/api/parties?${params.toString()}`,
        {
          signal: controller.signal,
        },
      ).then(({ ok, data, aborted }) => {
        if (aborted || controller.signal.aborted) return;
        const rows = ok ? (data.customers ?? []) : [];
        setMatches(
          excludeId ? rows.filter((row) => row.id !== excludeId) : rows,
        );
        setSearched(true);
        setSearching(false);
      });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, trimmed, excludeId]);

  return { matches, searching, searched };
}

/**
 * The dialog form of the search: an input, live matches as chips, a selected
 * state with a way out, and an honest line when a search found nobody.
 *
 * Uncontrolled except through `onPick`/`onClear` — the *chosen* customer stays
 * the parent's state, because it is part of what the dialog saves; only the
 * search text, which the saved record never keeps, belongs to this control.
 */
export function CustomerSearchField({
  selectedId,
  selectedName,
  onPick,
  onClear,
  emptyText,
  ariaLabel = "جستجوی مشتری",
  placeholder = "جستجوی نام یا شماره…",
}: {
  /** The chosen customer's id, or null while the dialog is searching. */
  selectedId: string | null;
  /** The chosen customer's display name — shown while one is selected. */
  selectedName: string;
  onPick: (match: CustomerSearchMatch) => void;
  onClear: () => void;
  /** Shown when a completed search matched nobody — silence reads as "loading". */
  emptyText: string;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const { matches, searching, searched } = useCustomerSearch(query, {
    enabled: !selectedId,
  });

  if (selectedId) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm text-foreground">
          {selectedName.trim() || "مشتری انتخاب‌شده"}
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={onClear}>
          تغییر
        </Button>
      </div>
    );
  }

  return (
    <>
      <input
        className={inputClass}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {searching ? (
        <LoadingSkeleton
          rows={1}
          compact
          className="mt-1"
          label="در حال جست‌وجوی مشتری"
        />
      ) : matches.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {matches.slice(0, 6).map((match) => (
            <li key={match.id}>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onPick(match)}
              >
                {match.name}
              </Button>
            </li>
          ))}
        </ul>
      ) : searched && query.trim().length >= 2 ? (
        <p className="mt-1 text-xs text-muted-foreground">{emptyText}</p>
      ) : null}
    </>
  );
}
