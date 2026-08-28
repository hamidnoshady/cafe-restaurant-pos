"use client";

/**
 * Quick date ranges for the reports screens, expressed in the branch's own
 * business days (روز کاری).
 *
 * Every report buckets on `app_business_date` (migration 0076), but the date
 * pickers beside this are a calendar — and for a branch trading 18:00→03:00 the
 * two disagree for the whole second half of every service. At 01:00 the
 * calendar says the 17th while the service in progress is filed under the 16th,
 * so picking "today" by hand asks for a business day that has not started and
 * returns an empty report. These presets take the current business date from
 * the server, so nobody has to work that out.
 *
 * The presets are shown whether or not a business day is configured: for a
 * branch that has none they are the calendar day, which is a useful shortcut
 * anyway. Only the explanatory note below is conditional, since it has nothing
 * to say to a branch whose day already starts at midnight.
 */
import { useEffect, useState } from "react";
import {
  businessDateRange,
  formatStartTime,
  type BusinessDateRangePreset,
} from "@/lib/business-day";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";

interface BusinessDayInfo {
  enabled: boolean;
  startMinutes: number | null;
  businessDate: string;
}

const PRESETS: { key: BusinessDateRangePreset; label: string }[] = [
  { key: "current_day", label: "روز کاری جاری" },
  { key: "previous_day", label: "روز کاری قبلی" },
  { key: "last_7_days", label: "۷ روز اخیر" },
  { key: "last_30_days", label: "۳۰ روز اخیر" },
];

const CHIP_CLASS =
  "min-h-9 rounded-lg border border-stone-200/80 bg-white px-3 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-[0.98]";

export function BusinessDayRangePresets({
  onSelect,
  onClear,
}: {
  onSelect: (range: { dateFrom: string; dateTo: string }) => void;
  onClear: () => void;
}) {
  const [info, setInfo] = useState<BusinessDayInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/business-day")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data?.businessDay) setInfo(data.businessDay);
      })
      // A branch with no business day still gets working presets from the
      // buttons below once this resolves; a failure just leaves them disabled
      // rather than guessing a date the server did not give us.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            disabled={!info}
            onClick={() => info && onSelect(businessDateRange(preset.key, info.businessDate))}
            className={CHIP_CLASS + " disabled:opacity-50"}
          >
            {preset.label}
          </button>
        ))}
        <button type="button" onClick={onClear} className={CHIP_CLASS}>
          همهٔ داده‌ها
        </button>
      </div>

      {info?.enabled && info.startMinutes !== null ? (
        <p className="mt-2 text-xs text-stone-500">
          روز کاری این شعبه از ساعت {toPersianDigits(formatStartTime(info.startMinutes))} شروع
          می‌شود، بنابراین تاریخ‌های این گزارش روز کاری هستند نه روز تقویمی؛ فروش بعد از نیمه‌شب
          در همان روز کاری قبل ثبت می‌شود. روز کاری جاری:{" "}
          {toPersianDigits(formatJalali(info.businessDate, { withMonthName: true }))}.
        </p>
      ) : null}
    </div>
  );
}
