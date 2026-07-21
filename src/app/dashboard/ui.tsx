"use client";

/** Small shared UI pieces for dashboard pages (menu management, POS). */

export async function api<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...init,
  });
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  return { ok: res.ok, status: res.status, data };
}

/** Persian messages for the API's error codes. */
export function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    missing_fields: "فیلدهای الزامی را پر کنید.",
    no_location: "شعبه‌ای ثبت نشده است.",
    invalid_rate: "نرخ مالیات باید بین ۰ و ۱۰۰ باشد.",
    category_exists: "دسته‌ای با این نام وجود دارد.",
    category_not_found: "دسته پیدا نشد.",
    item_not_found: "آیتم پیدا نشد.",
    group_not_found: "گروه افزودنی پیدا نشد.",
    modifier_not_found: "افزودنی پیدا نشد.",
    table_exists: "میزی با این نام وجود دارد.",
    table_not_found: "میز پیدا نشد.",
    table_required: "برای سفارش حضوری انتخاب میز الزامی است.",
    table_occupied: "این میز سفارش باز دیگری دارد.",
    invalid_order_type: "نوع سفارش نامعتبر است.",
    no_items: "حداقل یک قلم لازم است.",
    invalid_item: "تعداد یکی از اقلام معتبر نیست.",
    invalid_modifier: "یکی از افزودنی‌های انتخابی معتبر نیست.",
    invalid_modifier_selection: "انتخاب افزودنی‌ها با محدودیت گروه هم‌خوانی ندارد.",
    invalid_discount: "مقدار تخفیف معتبر نیست.",
    order_not_found: "سفارش پیدا نشد.",
    order_not_open: "این سفارش دیگر باز نیست و قابل ویرایش نیست.",
    item_already_voided: "این قلم قبلاً باطل شده است.",
    not_found: "پیدا نشد.",
    // Phase 3 — tables, sessions, reservations
    section_exists: "بخشی با این نام وجود دارد.",
    section_not_found: "بخش پیدا نشد.",
    waiter_not_found: "گارسون انتخاب‌شده معتبر نیست.",
    table_unavailable: "این میز در دسترس نیست (نظافت یا خارج از سرویس).",
    table_in_use: "این میز نشست باز دارد و حذف نمی‌شود.",
    invalid_status: "وضعیت میز نامعتبر است.",
    invalid_transition: "این تغییر وضعیت میز مجاز نیست.",
    seat_via_session: "برای نشاندن مهمان از «باز کردن میز» استفاده کنید.",
    session_not_found: "نشست میز پیدا نشد.",
    invalid_guests: "تعداد مهمان‌ها برای تقسیم صورتحساب معتبر نیست.",
    invalid_split: "تقسیم صورتحساب معتبر نیست.",
    reservation_conflict: "این میز در این بازهٔ زمانی رزرو دیگری دارد.",
    reservation_not_found: "رزرو پیدا نشد.",
    reservation_not_booked: "این رزرو دیگر در وضعیت رزرو نیست.",
    invalid_time: "زمان واردشده معتبر نیست.",
    time_in_past: "زمان رزرو نمی‌تواند در گذشته باشد.",
    invalid_party_size: "تعداد نفرات باید بزرگ‌تر از صفر باشد.",
    no_tables: "حداقل یک میز لازم است.",
    // Phase 5 — offline queue, payments, hardware
    invalid_payment_method: "روش پرداخت نامعتبر است.",
    conflict: "این تغییر با یک عملیات دیگر تداخل دارد و باید دستی بررسی شود.",
    printer_not_found: "چاپگر پیدا نشد.",
    agent_unreachable: "دستگاه چاپ در دسترس نیست. اتصال چاپگر محلی را بررسی کنید.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {children}
    </div>
  );
}

export function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
      {children}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-stone-400">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100";

export function PrimaryButton({
  children,
  disabled,
  onClick,
  type = "submit",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "submit" | "button";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 disabled:opacity-50"
    >
      {children}
    </button>
  );
}
