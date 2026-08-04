"use client";

/** Small shared UI pieces for dashboard pages (menu management, POS). */
import { CircleAlertIcon, InfoIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

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
    invalid_margin: "درصد حاشیه سود باید بین ۰ و ۱۰۰ باشد.",
    invalid_overhead: "درصد سربار برآوردی معتبر نیست.",
    invalid_commission_percent: "درصد کارمزد باید بین ۰ و ۱۰۰ باشد.",
    invalid_category_rate: "نرخ یکی از دسته‌ها معتبر نیست.",
    invalid_accounts: "ساختار سرفصل حساب‌ها معتبر نیست.",
    accounts_in_use: "به‌دلیل وجود اسناد حسابداری، جایگزین‌کردن سرفصل‌ها ممکن نیست.",
    missing_file: "فایل را انتخاب کنید.",
    file_too_large: "حجم فایل بیش از حد مجاز است.",
    unsupported_format: "فرمت فایل پشتیبانی نمی‌شود. CSV یا XLSX استفاده کنید.",
    parse_failed: "خواندن فایل ممکن نشد.",
    nothing_to_import: "آیتمی برای ورود پیدا نشد.",
    invalid_import: "فایل برای ورود آماده نیست.",
    invalid_printer: "اطلاعات چاپگر معتبر نیست؛ نام، IP، پورت و عرض کاغذ را بررسی کنید.",
    invalid_label: "نام دستگاه باید بین ۱ تا ۸۰ کاراکتر باشد.",
    device_not_found: "دستگاه پیدا نشد یا قبلاً حذف شده است.",
    employee_not_found: "کارمند پیدا نشد.",
    session_required: "برای شروع شیفت باید دوباره وارد شوید.",
    shift_already_open: "شیفتی از قبل باز است.",
    no_active_shift: "شیفت بازی برای پایان دادن پیدا نشد.",
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
    // Phase 7 — ledger
    ledger_account_missing: "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد. سرفصل حساب‌ها را بررسی کنید.",
    // Phase 11 — delivery
    address_required: "برای سفارش ارسالی، آدرس الزامی است.",
    invalid_delivery_fee: "هزینهٔ ارسال معتبر نیست.",
    courier_not_found: "پیک انتخاب‌شده معتبر نیست.",
    courier_required: "برای این وضعیت باید ابتدا پیک تخصیص یابد.",
    name_required: "نام الزامی است.",
    delivery_not_found: "سفارش ارسالی پیدا نشد.",
    delivery_already_closed: "این ارسال بسته شده و قابل تغییر نیست.",
    invalid_delivery_transition: "این تغییر وضعیت ارسال مجاز نیست.",
    invalid_delivery_status: "وضعیت ارسال نامعتبر است.",
    // Phase 13 — teams & permissions
    invalid_role: "نقش انتخاب‌شده معتبر نیست.",
    invalid_email: "ایمیل معتبر نیست.",
    invalid_pin: "رمز عددی باید دقیقاً ۴ رقم باشد.",
    pin_taken: "این رمز عددی قبلاً برای عضو دیگری ثبت شده است.",
    email_taken: "این ایمیل قبلاً در این کسب‌وکار ثبت شده است.",
    email_required: "برای این نقش ایمیل الزامی است.",
    pin_required: "برای این نقش رمز عددی الزامی است.",
    weak_password: "رمز عبور باید حداقل ۸ نویسه باشد.",
    already_a_member: "این شخص هم‌اکنون عضو این کسب‌وکار است.",
    role_not_invitable: "این نقش با رمز عددی ساخته می‌شود و قابل دعوت نیست.",
    last_owner: "این تنها مالک فعال کسب‌وکار است؛ ابتدا مالک دیگری اضافه کنید.",
    invalid_invitation: "این لینک دعوت معتبر نیست.",
    invitation_accepted: "این دعوت قبلاً پذیرفته شده است.",
    invitation_revoked: "این دعوت لغو شده است.",
    invitation_expired: "این دعوت منقضی شده است.",
    invalid_current_password: "رمز عبور فعلی درست نیست.",
    no_login: "این عضو حساب ورود با ایمیل ندارد.",
    nothing_to_change: "تغییری برای ذخیره وجود ندارد.",
    business_suspended: "دسترسی این کسب‌وکار موقتاً معلق شده است.",
    // Phase 14 — branches
    last_active_branch: "این تنها شعبهٔ فعال کسب‌وکار است و قابل غیرفعال‌سازی نیست.",
    branch_has_open_orders: "این شعبه سفارش باز دارد و قابل غیرفعال‌سازی نیست.",
    branch_has_open_sessions: "این شعبه نشست میز باز دارد و قابل غیرفعال‌سازی نیست.",
    source_branch_not_found: "شعبهٔ مبدأ برای کپی منو پیدا نشد.",
    missing_location: "شعبه‌ای انتخاب نشده است.",
    // Phase 22 Wave 4 (tip capture) — issue #160 §4
    invalid_tip_amount: "مبلغ انعام معتبر نیست.",
    // Phase 16 — AR subledger
    customer_required: "برای پرداخت نسیه انتخاب مشتری الزامی است.",
    customer_not_found: "مشتری انتخاب‌شده معتبر نیست.",
    invalid_amount: "مبلغ معتبر نیست.",
    invalid_method: "روش دریافت معتبر نیست.",
    supplier_required: "انتخاب تأمین‌کننده الزامی است.",
    supplier_not_found: "تأمین‌کننده انتخاب‌شده معتبر نیست.",
    // Phase 16 — bank & cash reconciliation
    invalid_account: "حساب انتخاب‌شده معتبر نیست.",
    statement_date_required: "تاریخ صورتحساب الزامی است.",
    reconciliation_in_progress: "یک تطبیق ناتمام برای این حساب وجود دارد؛ ابتدا آن را تکمیل کنید.",
    reconciliation_not_found: "تطبیق پیدا نشد.",
    reconciliation_completed: "این تطبیق قبلاً قفل شده و قابل تغییر نیست.",
    journal_line_not_found: "سند انتخاب‌شده معتبر نیست.",
    balance_mismatch: "مانده محاسبه‌شده با مانده صورتحساب برابر نیست.",
    // Phase 17 — plan limits / feature gating
    feature_disabled: "این امکان برای کسب‌وکار شما فعال نیست.",
    branch_limit_exceeded: "به سقف تعداد شعبه در پلن فعلی رسیده‌اید. برای افزودن شعبهٔ بیشتر، پلن را ارتقا دهید.",
    member_limit_exceeded: "به سقف تعداد اعضای پلن فعلی رسیده‌اید. برای افزودن عضو بیشتر، پلن را ارتقا دهید.",
    monthly_order_limit_exceeded:
      "به سقف تعداد سفارش‌های این ماه در پلن فعلی رسیده‌اید. برای ثبت سفارش بیشتر، پلن را ارتقا دهید.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <Alert variant="destructive" className="mb-4 border-destructive/30 bg-destructive/5">
      <CircleAlertIcon />
      <AlertDescription className="text-destructive">{children}</AlertDescription>
    </Alert>
  );
}

export function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="mb-4 border-primary/30 bg-primary/5">
      <InfoIcon className="text-primary" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
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
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/** shadcn <Input>-equivalent classes for raw <input>/<select>/<textarea> elements. */
export const inputClass =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30";

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
    <Button
      type={type}
      onClick={onClick}
      disabled={disabled}
      size="lg"
      className="w-full px-5 font-semibold"
    >
      {children}
    </Button>
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
    <Button type="button" variant="outline" onClick={onClick} disabled={disabled} className="px-4">
      {children}
    </Button>
  );
}
