"use client";

import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  SERVICE_REMINDER_STATE_LABELS,
  type ServiceReminder,
  type ServiceReminderState,
} from "./watch-manager";

const STATE_BADGE_CLASS: Record<ServiceReminderState, string> = {
  overdue: "bg-rose-100 text-rose-900",
  due: "bg-amber-100 text-amber-900",
};

/**
 * The due-for-service list (Wave 10): sold units whose next service — sale
 * date plus the model's service interval — is due or past. The proactive AI
 * agent turns the same list into shop-facing reminder drafts.
 */
export function RemindersSection({ reminders }: { reminders: ServiceReminder[] }) {
  return (
    <section aria-labelledby="watch-reminders-heading" className="min-w-0 overflow-hidden rounded-2xl bg-card">
      <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
        <h2 id="watch-reminders-heading" className="font-semibold text-stone-950">
          یادآوری سرویس
        </h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          ساعت‌های فروخته‌شده‌ای که موعد سرویسشان رسیده یا نزدیک است — بر پایهٔ فاصلهٔ سرویس مدل از زمان فروش.
          برای فعال‌کردن پیش‌نویس‌های خودکار، ایجنت «یادآور سرویس ساعت» را در بخش هوش مصنوعی روشن کنید.
        </p>
      </div>

      {reminders.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
          ساعتی که نیاز به سرویس داشته باشد وجود ندارد.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200/80">
          {reminders.map((reminder) => (
            <li
              key={reminder.serialId}
              className="flex min-w-0 flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h3 className="min-w-0 break-words font-semibold text-stone-950">{reminder.itemName}</h3>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {reminder.serialNumber}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_BADGE_CLASS[reminder.state]}`}
                  >
                    {SERVICE_REMINDER_STATE_LABELS[reminder.state]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  موعد سرویس: {toPersianDigits(formatJalali(reminder.referenceDate, { withMonthName: true }))}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
