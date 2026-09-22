"use client";

/**
 * The one customer control the food-service till uses — in the POS cart (both
 * the desktop panel and the phone sheet) and inside the open-order modal.
 *
 * A cashier must be able to, without leaving the order:
 *   1. search the directory by name or mobile (server-side: the directory is
 *      longer than any page a browser should hold),
 *   2. pick an existing customer,
 *   3. clear back to «بدون مشتری»,
 *   4. quick-create a customer from just a name and a phone number — a tiny
 *      two-field sheet, never the CRM's full form — and land back with the new
 *      customer selected, the cart untouched and a toast confirming it.
 *
 * The search is debounced and aborts stale requests, and asks the directory
 * for each result's balance (AR debt / store credit) so the control can show
 * one subtle line — a cash desk, not an accounting report — only when the
 * ledger actually backs a number.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon, UserIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api, errorMessage } from "./ui";
import { popoverPanelClass } from "./page-chrome";
import { FOCUS } from "./orders/ops-styles";

/** A customer as the till needs them — the directory row plus its balances. */
export interface PickerCustomer {
  id: string;
  name: string;
  phone: string | null;
  /** A/R balance in Rial (positive = the customer owes). */
  balance?: number;
  /** Store-credit balance in Rial (positive = the business owes). */
  storeCredit?: number;
}

/** The subtle balance line — rendered only for a balance the ledger backs. */
function CustomerBalanceLine({ customer }: { customer: PickerCustomer }) {
  const money = useMoney();
  const balance = customer.balance ?? 0;
  const credit = customer.storeCredit ?? 0;
  if (balance === 0 && credit === 0) return null;
  return (
    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
      {balance > 0 ? (
        <span className="font-semibold text-amber-700 dark:text-amber-300">
          بدهی: {money.format(balance, { withUnit: false })} {money.unitLabel}
        </span>
      ) : null}
      {balance > 0 && credit > 0 ? " · " : ""}
      {credit > 0 ? (
        <span className="font-semibold text-emerald-700 dark:text-emerald-300">
          اعتبار: {money.format(credit, { withUnit: false })} {money.unitLabel}
        </span>
      ) : null}
    </span>
  );
}

function customerLabel(customer: PickerCustomer | null): string {
  if (!customer) return "بدون مشتری";
  return customer.phone
    ? `${customer.name} — ${toPersianDigits(customer.phone)}`
    : customer.name;
}

export function CustomerPicker({
  customer,
  onChange,
  disabled = false,
  canCreate = true,
  idPrefix = "customer",
  onAfterCreate,
  requestOpen = 0,
  className = "",
}: {
  customer: PickerCustomer | null;
  onChange: (customer: PickerCustomer | null) => void;
  disabled?: boolean;
  /** Quick-create is the POS/order-modal behaviour; surfaces that never create pass false. */
  canCreate?: boolean;
  /** Distinguishes two pickers rendered at once (POS panel + phone sheet). */
  idPrefix?: string;
  /** Called after a quick-create succeeded, beside the standard select+toast. */
  onAfterCreate?: (customer: PickerCustomer) => void;
  /**
   * A counter the parent bumps to open this picker programmatically — the
   * payment panel's «انتخاب یا افزودن مشتری» action, when the difference
   * preview demands a person. 0 (the default) never opens anything.
   */
  requestOpen?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (requestOpen > 0) setOpen(true);
  }, [requestOpen]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerCustomer[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createPhone, setCreatePhone] = useState("");
  const [creating, setCreating] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const money = useMoney();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(
      () => {
        void api<{ customers?: PickerCustomer[] }>(
          "/api/parties?withBalance=1&q=" + encodeURIComponent(query.trim()),
          { signal: controller.signal },
        )
          .then(({ ok, data, aborted }) => {
            if (cancelled || aborted) return;
            if (ok) {
              setResults(data.customers ?? []);
              // The chosen customer stays at the top even when a later search
              // stops matching them, so the trigger never shows a selection
              // the list contradicts.
              if (customer && !data.customers?.some((row) => row.id === customer.id)) {
                setResults([customer, ...(data.customers ?? [])]);
              }
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (!cancelled) setLoading(false);
          });
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
    // `customer` intentionally not a dependency: it only seeds the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      // Focus the search box when the popover opens — one fewer tap.
      requestAnimationFrame(() => searchInputRef.current?.focus());
    } else {
      setQuery("");
    }
  }, [open]);

  const pick = useCallback(
    (next: PickerCustomer | null) => {
      onChange(next);
      setOpen(false);
    },
    [onChange],
  );

  async function createCustomer() {
    const name = createName.trim();
    if (!name || creating) return;
    setCreating(true);
    const { ok, data } = await api<{ customer?: PickerCustomer; error?: string }>("/api/parties", {
      method: "POST",
      body: JSON.stringify({ name, phone: createPhone.trim() || undefined }),
    });
    setCreating(false);
    if (!ok || !data.customer) {
      toast.error(errorMessage(data.error));
      return;
    }
    // Auto-select, keep every other piece of order state untouched, confirm.
    onChange(data.customer);
    onAfterCreate?.(data.customer);
    setCreateOpen(false);
    setOpen(false);
    setCreateName("");
    setCreatePhone("");
    toast.success(`مشتری «${data.customer.name}» ثبت و انتخاب شد.`);
  }

  const hasExactMatch = useMemo(
    () => results.some((row) => row.name === query.trim() || row.phone === query.trim()),
    [query, results],
  );

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => (index + offset + results.length) % Math.max(results.length, 1));
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const row = results[activeIndex];
      if (row) pick(row);
      else if (canCreate && query.trim()) {
        setCreateName(query.trim());
        setCreateOpen(true);
      }
    }
  }

  return (
    <>
      <Popover.Root open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
        <Popover.Trigger
          disabled={disabled}
          aria-label={"مشتری: " + customerLabel(customer)}
          className={
            "flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border px-3 text-sm font-bold transition-colors disabled:opacity-55 " +
            (customer
              ? "border-amber-500 dark:border-amber-500/60 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"
              : "border-border/80 bg-muted text-muted-foreground hover:border-amber-500/60 dark:hover:border-amber-500/60") +
            ` ${FOCUS} ${className}`
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <UserIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate text-start">{customerLabel(customer)}</span>
          </span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-70" aria-hidden="true" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            sideOffset={6}
            align="start"
            dir="rtl"
            className={`z-50 w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden ${popoverPanelClass}`}
          >
            <div className="border-b border-border/80 p-2">
              <div className="relative">
                <SearchIcon
                  className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                  onKeyDown={handleSearchKeyDown}
                  className="min-h-11 w-full rounded-xl border border-border/80 bg-muted ps-10 pe-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60"
                  placeholder="جستجوی نام یا شماره…"
                  aria-label="جستجوی مشتری"
                />
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto overscroll-contain">
              {customer ? (
                <button
                  type="button"
                  onClick={() => pick(null)}
                  className="flex min-h-11 w-full items-center justify-between gap-2 px-3 text-start text-sm text-muted-foreground transition-colors hover:bg-muted"
                >
                  <span className="flex items-center gap-2">
                    <XIcon className="size-4" aria-hidden="true" />
                    بدون مشتری
                  </span>
                </button>
              ) : null}
              {loading && results.length === 0 ? (
                <div className="space-y-2 p-3" aria-busy="true" aria-label="در حال جست‌وجوی مشتری">
                  <div className="ops-skeleton h-11 rounded-xl" />
                  <div className="ops-skeleton h-11 rounded-xl" />
                </div>
              ) : results.length === 0 ? (
                <p className="p-4 text-center text-xs leading-6 text-muted-foreground">
                  مشتری‌ای با این نام یا شماره پیدا نشد.
                </p>
              ) : (
                <ul role="listbox" aria-label="نتایج جستجوی مشتری">
                  {results.map((row, index) => {
                    const active = index === activeIndex;
                    const chosen = customer?.id === row.id;
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={chosen}
                          onClick={() => pick(row)}
                          onMouseEnter={() => setActiveIndex(index)}
                          className={
                            "flex min-h-12 w-full items-start justify-between gap-2 px-3 py-2 text-start transition-colors " +
                            (active ? "bg-muted" : "bg-card")
                          }
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold text-foreground">
                              {row.name}
                              {row.phone ? (
                                <span className="ms-1.5 font-normal text-muted-foreground">
                                  {toPersianDigits(row.phone)}
                                </span>
                              ) : null}
                            </span>
                            <CustomerBalanceLine customer={row} />
                          </span>
                          {chosen ? (
                            <CheckIcon
                              className="mt-1 size-4 shrink-0 text-amber-700 dark:text-amber-300"
                              aria-hidden="true"
                            />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {canCreate ? (
              <div className="border-t border-border/80 p-2">
                <button
                  type="button"
                  onClick={() => {
                    setCreateName(query.trim() && !hasExactMatch ? query.trim() : "");
                    setCreateOpen(true);
                  }}
                  className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-amber-100 dark:bg-amber-500/20 px-3 text-sm font-bold text-amber-700 dark:text-amber-300 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/25"
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  افزودن مشتری جدید
                </button>
              </div>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      {/* Quick-create: two fields, nothing more. The CRM's full form stays in
          the CRM — this is the till's speed hatch, writing through the same
          canonical /api/parties endpoint. */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>افزودن مشتری جدید</DialogTitle>
            <DialogDescription>
              نام و شماره موبایل کافی است؛ بقیهٔ اطلاعات را می‌توان بعداً در CRM
              کامل کرد.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-xs font-semibold text-muted-foreground" htmlFor={idPrefix + "-quick-name"}>
              نام
              <input
                id={idPrefix + "-quick-name"}
                className="mt-1 min-h-12 w-full rounded-xl border border-border/80 bg-muted px-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60"
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder="مثلاً: امیر فهیم"
                autoFocus
              />
            </label>
            <label className="block text-xs font-semibold text-muted-foreground" htmlFor={idPrefix + "-quick-phone"}>
              موبایل <span className="font-normal">(اختیاری)</span>
              <input
                id={idPrefix + "-quick-phone"}
                className="mt-1 min-h-12 w-full rounded-xl border border-border/80 bg-muted px-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60"
                dir="ltr"
                inputMode="tel"
                value={createPhone}
                onChange={(event) => setCreatePhone(event.target.value)}
                placeholder="۰۹…"
              />
            </label>
          </div>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setCreateOpen(false)}
              className="min-h-11 rounded-xl border border-input px-4 text-sm font-semibold text-muted-foreground"
            >
              انصراف
            </button>
            <button
              type="button"
              onClick={() => void createCustomer()}
              disabled={!createName.trim() || creating}
              className="min-h-11 rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 disabled:opacity-55"
            >
              {creating ? "در حال ثبت…" : "ثبت و انتخاب"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The balance line for a *selected* customer, shown under the picker when useful. */
export function CustomerBalanceBadge({ customer }: { customer: PickerCustomer | null }) {
  if (!customer) return null;
  return <CustomerBalanceLine customer={customer} />;
}
