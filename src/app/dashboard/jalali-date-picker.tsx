"use client";

/**
 * Shamsi (Jalali) date picker — a drop-in replacement for the native
 * <input type="date">, which renders a Gregorian calendar. Same contract as
 * that input: `value` is an ISO/Gregorian date string (YYYY-MM-DD) or "" and
 * `onChange` reports the same, so callers keep storing ISO while the user only
 * ever sees a Jalali calendar. Fully RTL: the popover, the month header, the
 * weekday row (شنبه → جمعه) and the day grid all flow right-to-left.
 */
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import {
  isoDateToJalali,
  JALALI_MONTHS,
  jalaliMonthLength,
  jalaliToIsoDate,
  jalaliWeekdayColumn,
  todayJalali,
} from "@/lib/jalali";
import { popoverPanelClass } from "./page-chrome";

// The control class, kept here (not imported from ./ui) so this component stays
// theme-agnostic and can be dropped into the super-admin/platform console as
// well as the dashboard without dragging ./ui's API layer along. It is the same
// recipe as the dashboard `inputClass`, written from the theme tokens
// (`border-input`, `bg-transparent`, `ring-ring`) so it flips with dark mode on
// its own. The platform passes its own dark-theme `inputClass` via `className`
// instead; a caller can always override with `className`.
const DEFAULT_INPUT_CLASS =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

// شنبه … جمعه — the Persian week, starting Saturday.
const WEEKDAY_SHORT = ["ش", "ی", "د", "س", "چ", "پ", "ج"] as const;

function pad2(n: number): string {
  return toPersianDigits(String(n).padStart(2, "0"));
}

export function JalaliDatePicker({
  value,
  onChange,
  className,
  placeholder = "انتخاب تاریخ",
  clearable = true,
  disabled = false,
  popoverClass,
  ariaLabel,
  labelledBy,
}: {
  value: string;
  onChange: (iso: string) => void;
  className?: string;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
  /** Override the popover's background/text token classes (e.g. the dark
   *  super-admin console, where the shadcn `--popover` tokens are light). */
  popoverClass?: string;
  /**
   * An accessible name for the trigger. The control is a button, not an
   * `<input>`, so wrapping it in a `<label>` names nothing — a reader
   * announces only whatever date (or placeholder) it happens to show, and two
   * pickers on one form are then indistinguishable. Pass one of these, the
   * same contract `SearchableSelect` uses.
   */
  ariaLabel?: string;
  /** id of the visible label element, when the form already renders one. */
  labelledBy?: string;
}) {
  const selected = isoDateToJalali(value);
  const [open, setOpen] = useState(false);
  const today = todayJalali();
  // The month the calendar is currently showing (independent of the selection).
  const [view, setView] = useState({
    jy: selected?.jy ?? today.jy,
    jm: selected?.jm ?? today.jm,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const gridId = useId();

  // When the value changes from outside, follow it into view.
  useEffect(() => {
    if (selected) setView({ jy: selected.jy, jm: selected.jm });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function shiftMonth(delta: number) {
    setView((v) => {
      const total = (v.jy * 12 + (v.jm - 1)) + delta;
      return { jy: Math.floor(total / 12), jm: (total % 12) + 1 };
    });
  }

  function pick(jd: number) {
    onChange(jalaliToIsoDate(view.jy, view.jm, jd));
    setOpen(false);
  }

  function goToday() {
    setView({ jy: today.jy, jm: today.jm });
    onChange(jalaliToIsoDate(today.jy, today.jm, today.jd));
    setOpen(false);
  }

  const monthLen = jalaliMonthLength(view.jy, view.jm);
  const leadingBlanks = jalaliWeekdayColumn(view.jy, view.jm, 1);
  const label = selected
    ? `${toPersianDigits(selected.jy)}/${pad2(selected.jm)}/${pad2(selected.jd)}`
    : "";

  return (
    <div ref={rootRef} className="relative inline-block w-full" dir="rtl">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={`${className ?? DEFAULT_INPUT_CLASS} flex items-center justify-between gap-2 text-start`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabel ? undefined : labelledBy}
      >
        <span className={label ? "" : "text-muted-foreground"}>{label || placeholder}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {/*
            * «پاک کردن» was an <svg role="button">: not focusable, not
            * operable from a keyboard, and nested inside the trigger button —
            * which is invalid, so assistive technology could not reach it at
            * all. A real <span role="button"> with a tabIndex and key
            * handling is reachable; it stays a span because a <button> inside
            * a <button> is what the markup could not have.
            */}
          {clearable && value ? (
            <span
              role="button"
              tabIndex={0}
              aria-label="پاک کردن تاریخ"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg hover:bg-muted hover:text-foreground focus-visible:ring focus-visible:ring-ring/50 focus-visible:outline-none"
              onClick={(e) => {
                e.stopPropagation();
                onChange("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange("");
                }
              }}
            >
              <XIcon className="size-4" />
            </span>
          ) : null}
          <CalendarIcon className="size-4 shrink-0" />
        </span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="انتخاب تاریخ شمسی"
          className={
            popoverClass ??
            `absolute z-50 mt-1 w-64 ${popoverPanelClass} p-3`
          }
        >
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => shiftMonth(-1)}
              aria-label="ماه قبل"
              className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronRightIcon className="size-4" />
            </button>
            <span className="text-sm font-semibold">
              {JALALI_MONTHS[view.jm - 1]} {toPersianDigits(view.jy)}
            </span>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              aria-label="ماه بعد"
              className="rounded-lg p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronLeftIcon className="size-4" />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
            {WEEKDAY_SHORT.map((w, i) => (
              <span key={i} className="py-1">
                {w}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1" role="grid" aria-labelledby={gridId}>
            {Array.from({ length: leadingBlanks }).map((_, i) => (
              <span key={`b${i}`} />
            ))}
            {Array.from({ length: monthLen }, (_, i) => i + 1).map((d) => {
              const isSelected = selected && selected.jy === view.jy && selected.jm === view.jm && selected.jd === d;
              const isToday = today.jy === view.jy && today.jm === view.jm && today.jd === d;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => pick(d)}
                  aria-selected={isSelected || undefined}
                  className={`flex h-8 items-center justify-center rounded-lg text-sm transition-colors ${
                    isSelected
                      ? "bg-primary font-semibold text-primary-foreground"
                      : isToday
                        ? "border border-primary/50 text-primary hover:bg-muted"
                        : "hover:bg-muted"
                  }`}
                >
                  {toPersianDigits(d)}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs">
            <button type="button" onClick={goToday} className="font-medium text-primary hover:underline">
              امروز
            </button>
            {clearable ? (
              <button
                type="button"
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                پاک کردن
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
