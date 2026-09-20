"use client";

/**
 * URL-synchronised filter state for the console's operational lists.
 *
 * Every list (businesses, audit, payments, support, bug reports, CMS sites…)
 * shares one contract: filters live in the query string so a filtered view
 * survives refresh, can be shared into a support thread, and works with the
 * browser back/forward buttons. This hook owns that plumbing once.
 *
 * It intentionally keeps a local mirror of the params so typing stays instant
 * and only writes back to the URL (via `router.replace`, no history spam) — the
 * debouncing of the actual network call is the caller's concern (see
 * `useDebouncedValue`), keeping this hook about state, not transport.
 */
import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type FilterValues = Record<string, string>;

export interface UrlFilters<T extends FilterValues> {
  /** The current filter values, defaults applied. */
  values: T;
  /** Merge a partial patch and write it to the URL. */
  set: (patch: Partial<T>) => void;
  /** Reset every filter to its default and clear the query string. */
  reset: () => void;
  /** True when any filter differs from its default. */
  isFiltered: boolean;
}

/**
 * @param defaults The full set of filter keys with their default values. A key
 *   equal to its default is omitted from the URL to keep it clean.
 */
export function useUrlFilters<T extends FilterValues>(defaults: T): UrlFilters<T> {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const values = useMemo(() => {
    const next = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof T)[]) {
      const fromUrl = params.get(String(key));
      if (fromUrl !== null) next[key] = fromUrl as T[keyof T];
    }
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const set = useCallback(
    (patch: Partial<T>) => {
      const merged = { ...values, ...patch };
      const qs = new URLSearchParams();
      for (const key of Object.keys(defaults) as (keyof T)[]) {
        const value = merged[key];
        if (value !== undefined && value !== "" && value !== defaults[key]) {
          qs.set(String(key), String(value));
        }
      }
      const query = qs.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, pathname, router],
  );

  const reset = useCallback(() => {
    router.replace(pathname, { scroll: false });
  }, [pathname, router]);

  const isFiltered = useMemo(
    () => (Object.keys(defaults) as (keyof T)[]).some((key) => values[key] !== defaults[key]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values],
  );

  return { values, set, reset, isFiltered };
}

/**
 * Debounce a rapidly-changing value (a search box) so the network call fires
 * on a pause, not per keystroke. Pairs with `usePlatformQuery`'s cancellation.
 */
import { useEffect, useState } from "react";

export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}
