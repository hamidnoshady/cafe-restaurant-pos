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
const ERROR_MESSAGES: Record<string, string> = {
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
    code_required: "کد حساب الزامی است.",
    code_in_use: "این کد حساب قبلاً استفاده شده است.",
    parent_not_found: "حساب والد پیدا نشد.",
    parent_cycle: "حساب نمی‌تواند والد خودش یا زیرمجموعه‌اش باشد.",
    parent_too_deep: "حساب والد از سطح «تفصیلی» است و نمی‌تواند زیرمجموعه داشته باشد.",
    hierarchy_too_deep: "این جابه‌جایی باعث می‌شود ساختار حساب از سطح «تفصیلی» عمیق‌تر شود.",
    well_known_account: "این حساب برای عملکرد سیستم لازم است و قابل غیرفعال یا حذف نیست.",
    account_not_found: "حساب پیدا نشد.",
    account_has_postings: "این حساب سند خورده و قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید.",
    account_has_draft_postings: "این حساب در یک پیش‌نویس استفاده شده و قابل حذف نیست.",
    account_has_children: "ابتدا زیرمجموعه‌های این حساب را جابه‌جا یا حذف کنید.",
    missing_file: "فایل را انتخاب کنید.",
    file_too_large: "حجم فایل بیش از حد مجاز است.",
    unsupported_format: "فرمت فایل پشتیبانی نمی‌شود. CSV یا XLSX استفاده کنید.",
    parse_failed: "خواندن فایل ممکن نشد.",
    nothing_to_import: "آیتمی برای ورود پیدا نشد.",
    invalid_import: "فایل برای ورود آماده نیست.",
    invalid_printer: "اطلاعات چاپگر معتبر نیست؛ نام و اطلاعات اتصال (IP و پورت، نام چاپگر ویندوز یا مسیر USB) را بررسی کنید.",
    printer_save_failed: "ذخیرهٔ چاپگر در سرور انجام نشد. گزارش سرور را بررسی و دوباره تلاش کنید.",
    printer_list_failed: "خواندن چاپگرهای ذخیره‌شده از سرور انجام نشد.",
    // چاپ و فاکتور — the print template designer and the business logo.
    invalid_template: "قالب معتبر نیست؛ نام، کاغذ و بخش‌های قالب را بررسی کنید.",
    duplicate_template_name: "قالبی با این نام از قبل وجود دارد.",
    template_not_found: "قالب پیدا نشد یا قبلاً حذف شده است.",
    invalid_logo: "فایل لوگو معتبر نیست؛ تصویر PNG، JPEG، WebP یا SVG با حجم مجاز انتخاب کنید.",
    invalid_label: "نام دستگاه باید بین ۱ تا ۸۰ کاراکتر باشد.",
    device_not_found: "دستگاه پیدا نشد یا قبلاً حذف شده است.",
    employee_not_found: "کارمند پیدا نشد.",
    session_required: "برای شروع شیفت باید دوباره وارد شوید.",
    shift_already_open: "شیفتی از قبل باز است.",
    no_active_shift: "شیفت بازی برای پایان دادن پیدا نشد.",
    // روز کاری (business day)
    invalid_start_time: "ساعت شروع روز کاری معتبر نیست؛ به شکل ۱۸:۰۰ وارد کنید.",
    location_not_found: "شعبه پیدا نشد.",
    business_day_not_configured: "برای این شعبه روز کاری تعریف نشده است.",
    business_day_already_closed: "روز کاری جاری قبلاً بسته شده است.",
    business_day_not_closed: "روز کاری جاری بسته نشده است.",
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
    // سیستم ادواری — periodic-closing-service.ts / consumeInventoryExact guard.
    periodic_system_unsupported:
      "این عملیات در سیستم ادواری در دسترس نیست؛ بهای تمام‌شده در «بستن دوره» محاسبه می‌شود.",
    not_periodic_system: "این کسب‌وکار سیستم ادواری ندارد؛ بستن دوره فقط برای سیستم ادواری است.",
    invalid_period_end: "تاریخ پایان دوره معتبر نیست.",
    period_end_not_after_previous: "تاریخ پایان دوره باید بعد از آخرین دورهٔ بسته‌شده باشد.",
    count_line_missing: "برای همهٔ اقلامی که موجودی اول دوره یا خرید داشته‌اند باید شمارش ثبت شود (حتی صفر).",
    invalid_item: "تعداد یکی از اقلام معتبر نیست.",
    invalid_modifier: "یکی از افزودنی‌های انتخابی معتبر نیست.",
    invalid_modifier_selection: "انتخاب افزودنی‌ها با محدودیت گروه هم‌خوانی ندارد.",
    invalid_discount: "مقدار تخفیف معتبر نیست.",
    order_not_found: "سفارش پیدا نشد.",
    order_not_open: "این سفارش دیگر باز نیست و قابل ویرایش نیست.",
    order_not_completed: "فقط سفارش تسویه‌شده را می‌توان اصلاح یا حذف کرد.",
    order_has_returns: "برای این سفارش مرجوعی مشتری ثبت شده است؛ ابتدا مرجوعی را برگشت بزنید.",
    reason_required: "ثبت دلیل اصلاح الزامی است.",
    reason_too_long: "دلیل اصلاح بیش از حد طولانی است.",
    duplicate_item: "یک قلم دوبار در فهرست اصلاح آمده است.",
    consumption_layer_settled: "کسری موجودی این فروش با خرید یا شمارش بعدی تسویه شده و برگشت دقیق آن ممکن نیست.",
    consumption_reversal_inconsistent: "برگشت موجودی این فروش با ارزش ثبت‌شدهٔ آن هم‌خوانی ندارد.",
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
    // Splitting a bill across payment ways (migration 0091).
    no_payment: "روش دریافت وجه انتخاب نشده است.",
    payment_total_mismatch: "مجموع مبالغ روش‌های پرداخت باید دقیقاً برابر مبلغ فاکتور باشد.",
    too_many_tenders: "تعداد روش‌های پرداخت یک فاکتور بیش از حد مجاز است.",
    payment_reference_required: "برای این روش پرداخت، شمارهٔ پیگیری الزامی است.",
    invalid_settlement: "نحوهٔ تسویه نامعتبر است.",
    builtin_payment_method: "روش‌های پیش‌فرض حذف نمی‌شوند؛ می‌توانید آن‌ها را غیرفعال کنید.",
    builtin_settlement_locked: "نحوهٔ تسویهٔ روش‌های پیش‌فرض قابل تغییر نیست.",
    payment_method_in_use: "با این روش پرداخت قبلاً وجهی دریافت شده است؛ به‌جای حذف، آن را غیرفعال کنید.",
    payment_method_not_found: "روش پرداخت پیدا نشد.",
    conflict: "این تغییر با یک عملیات دیگر تداخل دارد و باید دستی بررسی شود.",
    printer_not_found: "چاپگر پیدا نشد.",
    agent_unreachable: "دستگاه چاپ در دسترس نیست. اتصال چاپگر محلی را بررسی کنید.",
    // Phase 7 — ledger
    ledger_account_missing: "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد. سرفصل حساب‌ها را بررسی کنید.",
    fiscal_period_locked: "دورهٔ مالی این تاریخ بسته شده و ثبت سند در آن ممکن نیست.",
    fiscal_period_soft_closed: "دورهٔ مالی این تاریخ نیمه‌بسته است؛ فقط مالک یا حسابدار می‌تواند در آن سند ثبت کند.",
    negative_ingredient_requirement: "یکی از افزودنی‌ها مقدار مادهٔ اولیه را منفی می‌کند. دستور پخت آن افزودنی را اصلاح کنید.",
    inventory_costing_conflict: "بهای مواد اولیهٔ این سفارش قابل محاسبه نیست. قیمت خرید و موجودی موادی که این سفارش مصرف می‌کند را بررسی کنید.",
    // Phase 11 — delivery
    address_required: "برای سفارش ارسالی، آدرس الزامی است.",
    invalid_delivery_fee: "هزینهٔ ارسال معتبر نیست.",
    courier_not_found: "پیک انتخاب‌شده معتبر نیست.",
    courier_required: "برای این وضعیت باید ابتدا پیک تخصیص یابد.",
    name_required: "نام الزامی است.",
    name_too_long: "نام بیش از حد طولانی است.",
    phone_too_long: "شمارهٔ تلفن بیش از حد طولانی است.",
    address_too_long: "آدرس بیش از حد طولانی است.",
    notes_too_long: "یادداشت بیش از حد طولانی است.",
    field_too_long: "یکی از فیلدها بیش از حد طولانی است.",
    item_name_too_long: "نام آیتم بیش از حد طولانی است.",
    invalid_guest_count: "تعداد مهمان معتبر نیست.",
    delivery_not_found: "سفارش ارسالی پیدا نشد.",
    delivery_already_closed: "این ارسال بسته شده و قابل تغییر نیست.",
    invalid_delivery_transition: "این تغییر وضعیت ارسال مجاز نیست.",
    invalid_delivery_status: "وضعیت ارسال نامعتبر است.",
    // Phase 13 — teams & permissions
    invalid_role: "نقش انتخاب‌شده معتبر نیست.",
    invalid_email: "ایمیل معتبر نیست.",
    invalid_pin: "رمز عددی باید ۴ تا ۱۲ رقم باشد.",
    pin_taken: "این رمز عددی قبلاً برای عضو دیگری ثبت شده است.",
    // Phase 42 — the member's login phone
    invalid_phone: "شمارهٔ موبایل معتبر نیست. نمونه: ۰۹۱۲۱۲۳۴۵۶۷",
    phone_taken: "این شمارهٔ موبایل قبلاً برای عضو دیگری ثبت شده است.",
    email_taken: "این ایمیل قبلاً در این کسب‌وکار ثبت شده است.",
    email_required: "برای این نقش ایمیل الزامی است.",
    pin_required: "برای این نقش رمز عددی الزامی است.",
    weak_password: "رمز عبور باید حداقل ۸ نویسه باشد.",
    // Phase 24 — the Owner's second factor is texted to this number as the
    // business is created, so provisioning cannot proceed without a valid one.
    invalid_owner_phone: "شمارهٔ موبایل مالک معتبر نیست. نمونه: ۰۹۱۲۱۲۳۴۵۶۷",
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
    branch_has_open_orders: "این شعبه سفارش باز دارد و قابل غیرفعال‌سازی نیست. ابتدا سفارش‌های باز را تسویه یا باطل کنید.",
    branch_has_open_sessions: "این شعبه نشست میز باز دارد و قابل غیرفعال‌سازی نیست. ابتدا میزهای باز را ببندید.",
    source_branch_not_found: "شعبهٔ مبدأ برای کپی منو پیدا نشد.",
    missing_location: "شعبه‌ای انتخاب نشده است.",
    branch_name_taken: "شعبهٔ دیگری با این نام وجود دارد. نام متفاوتی انتخاب کنید.",
    branch_already_active: "این شعبه از قبل فعال است.",
    branch_already_inactive: "این شعبه از قبل غیرفعال است.",
    invalid_timezone: "منطقهٔ زمانی معتبر نیست.",
    invalid_color: "رنگ انتخاب‌شده معتبر نیست.",
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
    // Phase 23 Wave 1 — server sync config & typable tokens (issue #174).
    // invalid_url / unknown_location predate this wave but had no Persian
    // string, so they fell through to the raw English code.
    invalid_url: "آدرس سرور معتبر نیست؛ باید با http:// یا https:// شروع شود.",
    unknown_location: "شعبهٔ فرستاده‌شده در این سرور شناخته نشد.",
    bad_prefix: "این توکن همگام‌سازی نیست؛ توکن معتبر با POS1 شروع می‌شود.",
    bad_length: "طول توکن درست نیست؛ احتمالاً کامل کپی نشده است.",
    bad_charset: "توکن شامل نویسه‌های نامعتبر است. حروف O و I و رقم‌های ۰ و ۱ در توکن به کار نمی‌روند.",
    bad_checksum: "توکن معتبر نیست؛ یک نویسه اشتباه تایپ یا جابه‌جا شده است.",
    // Phase 23 Wave 2 — deployment role
    central_server: "این سرور، سرور مرکزی است و تنظیمات اتصال برای آن معنا ندارد.",
    // Phase 28/40 — technical Connections and WP Manager integration actions.
    // Their vocabularies of failure are named here rather than falling through
    // to «خطای غیرمنتظره».
    not_central_server: "این نصب محلی است و کد اتصال صادر نمی‌کند؛ کد را از حساب ابری بگیرید.",
    code_not_found: "این کد پیدا نشد یا دیگر معتبر نیست.",
    api_key_not_found: "این کلید پیدا نشد یا قبلاً باطل شده است.",
    invalid_scopes: "حداقل یک دسترسی را برای کلید انتخاب کنید.",
    invalid_expiry: "مدت اعتبار کلید معتبر نیست.",
    invalid_base_url: "آدرس فروشگاه معتبر نیست.",
    missing_credentials: "کلیدهای REST ووکامرس را وارد کنید.",
    invalid_currency_unit: "واحد قیمت فروشگاه معتبر نیست.",
    invalid_web_service_url: "آدرس وب‌سرویس هلو معتبر نیست.",
    missing_web_service_credentials: "برای نوشتن از وب‌سرویس، آدرس و نام کاربری و رمز وب‌سرویس هلو را وارد کنید.",
    no_web_service_credentials: "اطلاعات وب‌سرویس هلو برای این اتصال ثبت نشده است.",
    no_sql_credentials: "اطلاعات SQL Server هلو برای این اتصال ثبت نشده است.",
    confirmation_mismatch: "عبارت تأیید دقیقاً مطابق متن خواسته‌شده نیست.",
    unknown_profile: "ابتدا اتصال هلو را تست کنید تا پروفایل ساختار دیتابیس شناسایی شود.",
    holoo_direct_sql_profile_not_pinned: "پروفایل فعلی با پروفایل پین‌شده برای SQL مستقیم هم‌خوان نیست؛ دوباره تست و مسلح‌سازی کنید.",
    holoo_owned: "این ردیف از هلو آمده و در حالت همراه مالکیت آن با هلو است.",
    opening_inventory_exists: "موجودی افتتاحیه قبلاً ثبت شده است.",
    missing_manifest: "فایل/مانیفست مهاجرت ارسال نشده است.",
    not_plugin_mode: "این اتصال از نوع «افزونهٔ وردپرس» نیست، پس توکن افزونه ندارد.",
    plugin_never_connected: "افزونهٔ وردپرس هنوز به این سامانه وصل نشده است.",
    // Errors the connection routes and the auth/isolation middleware can
    // return but that had no Persian string, so they fell through to the
    // generic «خطای غیرمنتظره» instead of naming what actually failed.
    invalid_name: "نام فروشگاه باید بین ۱ تا ۱۲۰ نویسه باشد.",
    wrong_origin: "این آدرس با نشست فعلی شما همخوانی ندارد؛ دوباره از آدرس خود کسب‌وکار وارد شوید.",
    rate_limited: "تعداد درخواست‌ها بیش از حد مجاز است؛ چند لحظه بعد دوباره تلاش کنید.",
    module_unavailable: "این بخش برای نوع کسب‌وکار شما فعال نیست.",
    impersonation_read_only: "در حالت مشاهدهٔ فقط‌خواندنی امکان تغییر وجود ندارد.",
    // Phase 36 — the CRM app. Each code names the thing the person has to fix,
    // not the constraint that fired: «نام بخش را بنویسید» is actionable,
    // «segment_name_required» is not.
    segment_not_found: "بخش پیدا نشد.",
    segment_name_required: "برای بخش یک نام بنویسید.",
    segment_definition_invalid: "قاعده‌های این بخش کامل نیستند؛ فیلد و شرط هر ردیف را بررسی کنید.",
    campaign_channel_invalid: "کانال ارسال نامعتبر است؛ پیامک یا ایمیل را انتخاب کنید.",
    segment_or_definition_required: "برای محاسبهٔ مخاطبان، یک بخش مشتریان یا مجموعه قاعده انتخاب کنید.",
    note_body_required: "متن یادداشت را بنویسید.",
    tag_required: "برچسب را بنویسید.",
    tag_action_invalid: "عملیات برچسب باید افزودن یا برداشتن باشد.",
    note_not_found: "یادداشت پیدا نشد.",
    consent_channel_invalid: "کانال ارتباط باید پیامک یا ایمیل باشد.",
    consent_state_required: "وضعیت رضایت (دادن یا پس‌گرفتن) مشخص نشده است.",
    consent_source_invalid: "منبع ثبت رضایت معتبر نیست.",
    merge_same_customer: "یک مشتری را نمی‌توان با خودش ادغام کرد.",
    deal_not_found: "معامله پیدا نشد.",
    deal_title_required: "برای معامله یک عنوان بنویسید.",
    deal_stage_invalid: "مرحلهٔ معامله معتبر نیست.",
    deal_value_invalid: "مبلغ معامله معتبر نیست.",
    deal_probability_invalid: "احتمال موفقیت باید بین ۰ تا ۱۰۰ باشد.",
    activity_not_found: "کار یا پیگیری پیدا نشد.",
    activity_subject_required: "برای این کار یک عنوان بنویسید.",
    activity_kind_invalid: "نوع کار معتبر نیست.",
    case_not_found: "تیکت پیدا نشد.",
    case_subject_required: "موضوع تیکت را بنویسید.",
    case_status_invalid: "وضعیت تیکت معتبر نیست.",
    case_priority_invalid: "اولویت تیکت معتبر نیست.",
    // Website manager (Eshobe headless CMS) — issue #378
    invalid_cms_base_url: "آدرس سرور CMS معتبر نیست؛ باید با https:// شروع شود.",
    invalid_domain: "دامنهٔ سایت معتبر نیست؛ فقط میزبان — مثل acme.ir.",
    invalid_api_key: "کلید API معتبر نیست؛ باید با eshobe_live_ شروع شود.",
    invalid_type: "نوع سایت معتبر نیست.",
    connection_failed: "اتصال برقرار نشد؛ آدرس، دامنه یا کلید را بررسی کنید.",
    cms_unreachable: "سرور CMS در دسترس نیست. بعداً دوباره تلاش کنید.",
    cms_old_version: "نسخهٔ CMS از این اتصال پشتیبانی نمی‌کند؛ سرور را به‌روزرسانی کنید.",
    domain_mismatch: "کلید متعلق به دامنهٔ دیگری است؛ دامنهٔ سایت را بررسی کنید.",
    cms_not_configured: "اتصال به پلتفرم سایت هنوز پیکربندی نشده است؛ با مدیر سیستم تماس بگیرید.",
    provision_failed: "ساخت سایت ناموفق بود؛ اطلاعات را بررسی و دوباره تلاش کنید.",
    key_issue_failed: "صادرکردن کلید سایت ناموفق بود.",
    not_connected: "هنوز اتصالی به سایت برقرار نشده است.",
    cms_config_error: "مشکل در دادهٔ ذخیره‌شدهٔ اتصال؛ دوباره متصل شوید.",
    cms_error: "خطا از سمت سرور سایت؛ بعداً دوباره تلاش کنید.",
    // Post/product/domain management from the Website app (post-#378 CRUD)
    title_required: "عنوان الزامی است.",
    content_required: "متن نوشته الزامی است.",
    invalid_price: "قیمت باید عدد صحیح و غیرمنفی باشد.",
    invalid_inventory: "موجودی باید عدد صحیح و غیرمنفی باشد.",
    domain_taken: "این دامنه قبلاً برای سایت دیگری ثبت شده است.",
    // Parties (the shared «اشخاص» record every app reads) — src/app/api/parties.
    // `validation_failed` is the collection's answer to a body the form rules
    // reject; the message per field comes from `partyFieldErrorMessage` in
    // src/lib/parties.ts, which is why this one stays general.
    validation_failed: "اطلاعات شخص کامل یا معتبر نیست؛ فیلدهای مشخص‌شده را بررسی کنید.",
    party_not_found: "این شخص پیدا نشد یا در همین کسب‌وکار نیست.",
    display_name_required: "نام نمایشی شخص الزامی است.",
    // `invalid_role` and `category_not_found` above already cover the party
    // routes' versions of those two codes; only the party-specific ones are added.
    invalid_person_type: "نوع شخص باید حقیقی یا حقوقی باشد.",
    accounting_code_required: "در حالت دستی، کد حسابداری شخص الزامی است.",
    accounting_code_taken: "این کد حسابداری برای شخص دیگری در همین کسب‌وکار استفاده شده است.",
    invalid_national_id: "کد ملی معتبر نیست.",
    national_id_taken: "این کد ملی قبلاً برای شخص دیگری ثبت شده است.",
    economic_code_invalid: "کد اقتصادی معتبر نیست (۱۱ رقم با رقم کنترلی).",
    iban_invalid: "شمارهٔ شبا معتبر نیست.",
    too_long: "مقدار یکی از فیلدها بلندتر از حد مجاز است.",
    email_too_long: "ایمیل بلندتر از حد مجاز است.",
    accounting_fields_forbidden: "فیلدهای حسابداری شخص (کد، نرخ مالیات، بانک) فقط با دسترسی «مشاهدهٔ دفتر» قابل ویرایش‌اند.",
    category_name_required: "نام دسته الزامی است.",
    category_name_too_long: "نام دسته بیش از ۸۰ نویسه است.",
    category_in_use: "این دسته در حال استفاده است و فقط غیرفعال می‌شود.",
    // Installments (کارت اقساط) — src/lib/installments-service.ts.
    invalid_down_payment: "پیش‌پرداخت نمی‌تواند منفی باشد.",
    down_payment_exceeds_principal: "پیش‌پرداخت از مبلغ کل بیشتر است.",
    invalid_installment_count: "تعداد اقساط معتبر نیست.",
    invalid_interval: "فاصله اقساط معتبر نیست.",
    invalid_due_date: "تاریخ اولین بازپرداخت را انتخاب کنید.",
    invalid_percent: "درصد سود/جریمه باید بین ۰ تا ۱۰۰ باشد.",
    invoice_required: "فاکتور را انتخاب کنید.",
    invoice_not_found: "فاکتور انتخاب‌شده پیدا نشد.",
    invoice_has_no_customer: "این فاکتور مشتری ندارد؛ اقساط فاکتوری فقط برای فاکتورهای دارای مشتری است.",
    invoice_not_on_credit: "این فاکتور نسیه نیست و بدهی‌ای برای قسط‌بندی ندارد؛ فقط فاکتورهای نسیه قابل قسط‌بندی‌اند.",
    party_required: "شخص را انتخاب کنید.",
    plan_not_found: "برنامه قسطی پیدا نشد.",
    plan_has_no_party: "این برنامه شخص طرف‌حساب ندارد.",
    already_paid: "این قسط قبلاً تسویه شده است.",
    already_voided: "این تعهد قبلاً ابطال شده است.",
    run_voided: "این تعهد ابطال شده و قابل پرداخت نیست.",
    run_not_found: "تعهد حقوق پیدا نشد.",
    no_wages_set: "هیچ عضو فعالی حقوق تعیین‌شده ندارد.",
    period_label_required: "عنوان دوره الزامی است.",
    supplier_record_missing: "این شخص در فهرست تأمین‌کنندگان ثبت نشده است؛ ابتدا او را به‌عنوان تأمین‌کننده ثبت کنید.",
    installment_amount_too_small: "مبلغ هر قسط بسیار کم است؛ تعداد اقساط را کاهش دهید.",
    item_required: "قسط را انتخاب کنید.",
};

export function errorMessage(code: string | undefined): string {
  return ERROR_MESSAGES[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}

/**
 * The mapped Persian message, or the raw code/message the server sent when it
 * is not in the map. Callers with a real error to show use this instead of
 * `errorMessage`, whose generic fallback would otherwise swallow the actual
 * reason (an unmapped code, or a free-text failure like a WooCommerce
 * connection error) behind «خطای غیرمنتظره».
 */
export function errorMessageOrRaw(code: string | undefined): string {
  if (!code) return "";
  return ERROR_MESSAGES[code] ?? code;
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
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

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
  className,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Button type="button" variant="outline" onClick={onClick} disabled={disabled} className={`px-4 ${className ?? ""}`}>
      {children}
    </Button>
  );
}
