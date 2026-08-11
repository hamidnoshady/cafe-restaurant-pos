"use client";

/**
 * SearchableSelect — a Select2-style combobox for React.
 *
 * A native <select> gets no type-to-filter; entity pickers (products, menu
 * items, suppliers, accounts, …) have long lists where search is the difference
 * between a few keystrokes and a long scroll. This wraps a Radix Popover with a
 * filter input so the search UX matches Select2 without pulling jQuery in.
 *
 * Usage mirrors a native select: controlled `value` + `onChange`, `options` as
 * { value, label }. Include a `{ value: "", label: … }` option to allow
 * clearing ("all / none"), matching how the codebase uses empty options today.
 */
import * as React from "react";
import { Popover } from "radix-ui";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { normalizePosSearchText } from "@/lib/pos-selection";

export interface SelectOption {
  value: string;
  label: string;
  /** Optional text searched instead of `label` when filtering (e.g. name + SKU + unit). */
  searchString?: string;
}

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  dir?: "rtl" | "ltr";
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "انتخاب کنید…",
  searchPlaceholder = "جستجو…",
  emptyText = "نتیجهای یافت نشد.",
  disabled,
  className,
  dir = "rtl",
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);
  const filtered = React.useMemo(() => {
    const q = normalizePosSearchText(query);
    return q
      ? options.filter((o) =>
          normalizePosSearchText(o.searchString ?? o.label).includes(q),
        )
      : options;
  }, [options, query]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Focus after the popover mounts so type-to-search works immediately.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  function select(option: SelectOption) {
    onChange(option.value);
    setOpen(false);
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          dir={dir}
          className={cn(
            "flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:border-ring dark:bg-input/30",
            !selected && "text-muted-foreground",
            className,
          )}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="min-w-0 truncate">{selected ? selected.label : placeholder}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          dir={dir}
          align="start"
          sideOffset={4}
          className="z-50 w-(--radix-popover-trigger-width) overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md outline-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="border-b border-border p-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setActiveIndex((i) => Math.max(i - 1, 0));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    const option = filtered[activeIndex];
                    if (option) select(option);
                  }
                }}
                placeholder={searchPlaceholder}
                className="h-8 ps-8"
                aria-autocomplete="list"
              />
            </div>
          </div>
          <ul
            role="listbox"
            className="max-h-64 overflow-y-auto p-1"
            onMouseDown={(e) => e.preventDefault() /* keep input focused on scroll */}
          >
            {filtered.length === 0 ? (
              <li className="px-2.5 py-2 text-sm text-muted-foreground">{emptyText}</li>
            ) : (
              filtered.map((option, i) => {
                const isActive = i === activeIndex;
                const isSelected = option.value === value;
                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => select(option)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-start outline-none",
                        isActive && "bg-accent text-accent-foreground",
                      )}
                    >
                      <span className="min-w-0 truncate">{option.label}</span>
                      {isSelected ? <CheckIcon className="size-4 shrink-0" /> : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
