/**
 * Persian labels for the database's own enum values.
 *
 * The assistant used to answer a question about bread waste with a footnote
 * reading «موارد ثبت‌شده تحت دلایل «spoilage» و «staff_meal»» — raw column
 * values, in English, shown to a café owner in Tehran. The model was not being
 * lazy: those were the only strings the tools ever gave it, so it had nothing
 * else to say.
 *
 * The fix belongs here rather than in the prompt. A label the tool returns is a
 * fact; a label the model is asked to translate on the fly is a guess, and a
 * guess about what a status *means* is exactly the kind of confident wrongness
 * that makes an owner distrust the whole feature.
 *
 * Every tool that returns an enum value returns its label alongside it.
 */

export const WASTE_REASON_LABELS: Record<string, string> = {
  spoilage: "فساد و ماندگی",
  prep_error: "خطای آماده‌سازی",
  customer_return: "برگشت از مشتری",
  staff_meal: "مصرف پرسنل",
  other: "سایر",
};

export const STOCK_MOVEMENT_LABELS: Record<string, string> = {
  purchase: "خرید",
  sale: "فروش",
  waste: "ضایعات",
  adjustment: "تعدیل شمارش",
  transfer_in: "انتقال ورودی",
  transfer_out: "انتقال خروجی",
  production_consume: "مصرف در تولید",
  production_output: "خروجی تولید",
};

export const INVENTORY_EVENT_LABELS: Record<string, string> = {
  opening: "افتتاحیه",
  purchase_receipt: "رسید خرید",
  sale_consumption: "مصرف فروش",
  waste: "ضایعات",
  stock_count_adjustment: "تعدیل شمارش",
  stock_count_reversal: "برگشت شمارش",
  customer_return: "برگشت از مشتری",
  supplier_return: "برگشت به تأمین‌کننده",
  transfer: "انتقال",
  transfer_ship: "ارسال انتقال",
  transfer_receive: "دریافت انتقال",
  nrv_write_down: "کاهش ارزش",
  nrv_reversal: "برگشت کاهش ارزش",
  sale_reversal: "برگشت فروش",
  production: "تولید",
  production_reversal: "برگشت تولید",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  open: "باز",
  held: "معلق",
  completed: "تسویه‌شده",
  voided: "باطل‌شده",
};

export const PURCHASE_STATUS_LABELS: Record<string, string> = {
  draft: "پیش‌نویس",
  ordered: "سفارش‌شده",
  received: "رسیدشده",
  cancelled: "لغوشده",
};

/**
 * Phase 36 — reservation statuses, in the same shape as the maps above.
 *
 * The labels already existed, but only inside `reservations-manager.tsx`'s
 * `STATUS_META`, which is a `"use client"` component carrying Tailwind classes:
 * unimportable from a service. The CRM's customer timeline needed the words
 * without the styling, and the alternative — printing the raw enum — puts
 * «وضعیت: no_show» in front of a Persian-speaking owner.
 */
export const RESERVATION_STATUS_LABELS: Record<string, string> = {
  booked: "رزرو",
  seated: "نشسته",
  completed: "تکمیل",
  cancelled: "لغو",
  no_show: "عدم حضور",
};

/** Falls back to the raw value rather than to an invented translation. */
export function labelFor(map: Record<string, string>, value: string | null | undefined): string {
  if (!value) return "نامشخص";
  return map[value] ?? value;
}

/** `{ code, label }` — so a tool result carries both the key and what it means. */
export function labelled(map: Record<string, string>, value: string | null | undefined) {
  return { code: value ?? null, label: labelFor(map, value) };
}

/**
 * Integer Rial → the Toman figure an owner actually speaks in, with Persian
 * digits and separators. Tools return this next to the Rial number so the model
 * never has to divide by ten itself — it gets that wrong, and a wrong number
 * about money is the worst thing this feature can produce.
 */
export function tomanText(rial: number): string {
  const toman = Math.round(rial / 10);
  return `${toman.toLocaleString("fa-IR")} تومان`;
}

export function moneyFields(rial: number): { rial: number; toman: number; text: string } {
  return { rial, toman: Math.round(rial / 10), text: tomanText(rial) };
}
