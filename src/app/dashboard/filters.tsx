"use client";

/**
 * Filter chrome — the row of chips and the search field the reference screens
 * put directly under a page header.
 *
 * The Orders screenshot is the canonical one: a full-width search field with a
 * leading magnifier, then a wrapping row of chips where the selected chip is
 * amber-filled and the rest are quiet outlines. The Inventory screenshot shows
 * the same chip row inline beside a search field, and Accounting's lists use
 * the chips alone.
 *
 * Every one of those screens previously wrote the chip's ~340 characters of
 * Tailwind by hand, once per chip, which is how three different focus rings and
 * two different active fills ended up in the product. `FilterChip` is that
 * spelling, once. `aria-pressed` (not `role="tab"`) because a chip toggles a
 * filter; the list under it is a plain region, not a tabpanel.
 */

import { SearchIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { inputClass } from "./ui";

/**
 * One filter chip. Amber fill when selected — amber is selection everywhere in
 * this language — and a quiet outline otherwise.
 *
 * `dense` is the POS/operational height (44px, thumb-sized). The default is the
 * ordinary page height (40px), which is what CRM, Growth and Website
 * Management should use: the POS's denser chrome is an approved variation of
 * this system, not a target for regular pages to imitate.
 */
export function FilterChip({
  children,
  selected,
  onClick,
  dense = false,
  className,
  ...rest
}: {
  children: ReactNode;
  selected: boolean;
  onClick: () => void;
  dense?: boolean;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "className" | "children">) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-xl border px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40",
        dense ? "min-h-11 font-bold" : "min-h-10",
        selected
          ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
          : "border-border/80 bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * The row chips sit in. Scrolls horizontally on a phone rather than wrapping
 * into a three-line block that pushes the list below the fold — which is what
 * the Orders screen does.
 */
export function FilterChipRow({
  label,
  children,
  className,
}: {
  /** Names the group for a screen reader («فیلتر وضعیت سفارش»). */
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {children}
    </div>
  );
}

/**
 * The search field with its leading magnifier and optional clear button.
 *
 * The icon is positioned with logical properties (`start-3`), so it sits on the
 * right in this RTL product and would flip correctly if the app were ever run
 * LTR. The clear button only renders when there is something to clear.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  id,
  className,
  onClear,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Accessible name. Required — a bare search box announces only "edit text". */
  label: string;
  id?: string;
  className?: string;
  /** Shows a clear button. Defaults to clearing through `onChange("")`. */
  onClear?: () => void;
}) {
  const clear = onClear ?? (() => onChange(""));
  return (
    <div className={cn("relative min-w-0", className)}>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
      />
      <input
        id={id}
        type="search"
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn(inputClass, "ps-9", value ? "pe-9" : "")}
      />
      {value ? (
        <button
          type="button"
          onClick={clear}
          aria-label="پاک‌کردن جستجو"
          className="absolute inset-y-0 end-2 my-auto flex size-6 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring focus-visible:ring-amber-400/40"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The filter panel itself — the bordered block holding a search field and its
 * chips, as the Orders and Inventory screens show. A plain layout wrapper on
 * purpose: it owns the spacing between the rows, nothing else, so a screen can
 * put whatever controls its workflow needs inside without fighting the shell.
 */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-3", className)}>{children}</div>;
}
