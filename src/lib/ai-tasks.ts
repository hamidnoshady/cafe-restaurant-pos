/**
 * The chat's task lens (ChatGPT's "GPTs"-style selector, requested in the
 * Phase 36c chat redesign).
 *
 * One catalog shared by the browser (the composer dropdown) and the server
 * (validation + the system-prompt directive for the turn). The browser maps
 * icons per id in `ai-task-selector.tsx`; this module deliberately imports
 * nothing UI-related so the server bundle never pulls lucide-react.
 *
 * A task is *not* a mode (wizard/dashboard/floor decide authz, tools and
 * read scope). It is a lens over the same mode: a focus directive plus the
 * starter suggestions shown while the conversation is still empty. The
 * "custom" task lets the owner type any job description for the assistant —
 * the task can be changed into anything else — which the server wraps in a
 * framed directive with the safety rules still taking precedence.
 */

import type { AgentMode } from "./ai";
import { MAX_CUSTOM_TASK_CHARS } from "./ai-attachment-limits";

export type AiTaskId =
  | "general"
  | "sales"
  | "inventory"
  | "accounting"
  | "menu"
  | "customers"
  | "marketing"
  | "operations"
  | "delivery"
  | "split"
  | "custom";

export interface AiTask {
  id: AiTaskId;
  /** Short Persian label for the dropdown and the header. */
  label: string;
  /** One-line description shown under the label in the dropdown. */
  description: string;
  /** Which assistant modes the task makes sense in. */
  modes: AgentMode[];
  /** Appended to the system prompt for the turn. Absent = default behaviour. */
  directive?: string;
  /** Starter chips while the conversation is empty (per-mode fallbacks below). */
  suggestions?: string[];
}

/**
 * The classic starter chips per assistant mode, used when the selected task
 * has no suggestions of its own (and by the wizard, which has no selector).
 */
export const SUGGESTED_PROMPTS: Record<"wizard" | "dashboard" | "floor", string[]> = {
  wizard: [
    "برای تکمیل این مرحله چه اطلاعاتی لازم است؟",
    "یک منوی اولیهٔ ساده برای کسب‌وکار پیشنهاد بده.",
    "تنظیمات مالیات و روش قیمت‌گذاری را بررسی کن.",
  ],
  dashboard: [
    "فروش هفتهٔ اخیر را خلاصه و با هفتهٔ قبل مقایسه کن.",
    "کدام آیتم‌های منو عملکرد ضعیف‌تری دارند؟",
    "موجودی کم و پیشنهادهای خرید را بررسی کن.",
  ],
  floor: [
    "مواد اولیهٔ ثبت‌شدهٔ یک آیتم منو را بگو.",
    "صورت‌حساب میز ۳ را برای ۴ نفر تقسیم کن.",
    "برای سؤال حساسیت غذایی چه داده‌ای ثبت شده است؟",
  ],
};

export const AI_TASKS: AiTask[] = [
  {
    id: "general",
    label: "دستیار عمومی",
    description: "پرسش آزاد دربارهٔ فروش، منو، موجودی و حسابداری",
    modes: ["dashboard", "floor"],
  },
  {
    id: "sales",
    label: "تحلیل فروش",
    description: "روندها، مقایسهٔ بازه‌ها، پرفروش‌ها و باطل‌شدن سفارش‌ها",
    modes: ["dashboard"],
    directive:
      "تمرکز این گفتگو تحلیل فروش و درآمد است: روند و مقایسهٔ بازه‌ها، پرفروش‌ترین و ضعیف‌ترین آیتم‌ها، ساعات اوج، و الگوی باطل‌شدن سفارش‌ها. از list_reports/run_report، get_menu_performance و get_void_pattern استفاده کن و یافته‌ها را با عدد، درصد و پیشنهاد کوتاه خلاصه کن.",
    suggestions: [
      "فروش امروز را با دیروز و هفتهٔ قبل مقایسه کن.",
      "پرفروش‌ترین و ضعیف‌ترین آیتم‌های این هفته کدام‌اند؟",
      "الگوی باطل‌شدن سفارش‌ها (void) را تحلیل کن.",
    ],
  },
  {
    id: "inventory",
    label: "موجودی و خرید",
    description: "ارزش موجودی، اقلام رو به اتمام، انقضا و تأمین‌کنندگان",
    modes: ["dashboard"],
    directive:
      "تمرکز این گفتگو موجودی و خرید است: ارزش موجودی (get_stock_valuation)، اقلام رو به اتمام، اقلام نزدیک انقضا (get_near_expiry_items)، عملکرد تأمین‌کنندگان (get_supplier_performance) و تخمین تقاضا (forecast_demand — همیشه صریح بگو تخمین است). پیشنهاد خرید را فقط بر اساس دادهٔ همین ابزارها بده.",
    suggestions: [
      "کدام اقلام رو به اتمام‌اند و باید خرید شوند؟",
      "ارزش موجودی فعلی انبار چقدر است؟",
      "اقلام نزدیک به انقضا را فهرست کن.",
    ],
  },
  {
    id: "accounting",
    label: "حسابداری و هزینه‌ها",
    description: "مطالبات، بدهی‌ها، مغایرت بانکی، حقوق، مالیات و ممیزی",
    modes: ["dashboard"],
    directive:
      "تمرکز این گفتگو حسابداری و هزینه‌ها است: مطالبات (get_ar_aging)، بدهی‌های آینده (get_ap_upcoming)، مغایرت بانکی (get_unreconciled_bank_lines)، حقوق (get_payroll_summary)، مالیات (get_vat_liability) و بررسی جامع حساب‌ها (run_accounting_review). هرگز موردی به یافته‌های ابزارها اضافه نکن.",
    suggestions: [
      "حساب‌هایم را کامل بررسی کن و یافته‌ها را بگو.",
      "مطالبات مشتریان و بدهی‌های آینده چقدر است؟",
      "مالیات بر ارزش افزودهٔ این دوره چقدر است؟",
    ],
  },
  {
    id: "menu",
    label: "منو و قیمت‌گذاری",
    description: "تحلیل عملکرد آیتم‌ها و مواد اولیهٔ ثبت‌شده",
    modes: ["dashboard", "floor"],
    directive:
      "تمرکز این گفتگو منو و قیمت‌گذاری است: با find_items و گزارش‌های منو تحلیل کن که کدام آیتم‌ها می‌فروشند و کدام نه. پیشنهاد قیمت را محتاطانه و فقط بر اساس دادهٔ واقعی بده و همیشه بگو که تصمیم نهایی با کاربر است.",
    suggestions: [
      "عملکرد آیتم‌های منو را تحلیل کن.",
      "مواد اولیهٔ ثبت‌شدهٔ یک آیتم منو را بگو.",
    ],
  },
  {
    id: "customers",
    label: "مشتریان و وفاداری",
    description: "پروفایل مشتری، ریزش، بخش‌بندی و خرید مجدد",
    modes: ["dashboard"],
    directive:
      "تمرکز این گفتگو مشتریان و وفاداری است: get_customer_profile، find_customers، get_customer_timeline، get_at_risk_customers، list_customer_segments، preview_customer_segment و get_repurchase_candidates. بخش‌ها را با نام و معیار فارسی توضیح بده.",
    suggestions: [
      "مشتریان در خطر ریزش چه کسانی‌اند؟",
      "کدام مشتری‌ها آمادهٔ خرید مجدد هستند؟",
      "بخش‌بندی مشتریانم را نشان بده.",
    ],
  },
  {
    id: "marketing",
    label: "رشد و بازاریابی",
    description: "ایدهٔ کمپین بر اساس بخش‌های مشتریان و ریزش",
    modes: ["dashboard"],
    directive:
      "تمرکز این گفتگو رشد و بازاریابی است: از بخش‌بندی مشتریان، مشتریان در خطر ریزش و آمادهٔ خرید مجدد شروع کن و پیشنهاد کمپین بده. پیشنهادها را قابل اجرا، کوتاه و بدون وعدهٔ عددی اثبات‌نشده بنویس.",
    suggestions: [
      "بر اساس بخش‌بندی مشتریان یک کمپین پیشنهاد بده.",
      "برای برگرداندن مشتریان در خطر ریزش چه کنم؟",
    ],
  },
  {
    id: "operations",
    label: "رزرو و میزها",
    description: "تداخل رزرو و گردش میزها",
    modes: ["dashboard"],
    directive:
      "تمرکز این گفتگو رزرو و میزها است: get_reservation_conflicts و get_table_turnover_rate. تداخل‌ها را با زمان و نام میز گزارش کن و پیشنهاد ساده بده.",
    suggestions: [
      "تداخل رزروهای امروز را بررسی کن.",
      "گردش میزها این هفته چطور بوده است؟",
    ],
  },
  {
    id: "delivery",
    label: "پیک و تحویل",
    description: "عملکرد پیک‌ها و زمان تحویل",
    modes: ["dashboard"],
    directive:
      "تمرکز این گفتگو پیک و تحویل سفارش است: از get_courier_performance استفاده کن و مقایسهٔ پیک‌ها را با زمان تحویل و تعداد سفارش خلاصه کن.",
    suggestions: ["عملکرد پیک‌ها را مقایسه کن."],
  },
  {
    id: "split",
    label: "تقسیم صورتحساب",
    description: "پیش‌نمایش تقسیم برابر صورتحساب میز بین نفرات",
    modes: ["floor"],
    directive:
      "تمرکز این گفتگو تقسیم صورتحساب میز است: فقط پیش‌نمایشِ تقسیم بده، همیشه بگو پیش‌نمایش است و هرگز چیزی ثبت نکن.",
    suggestions: [
      "صورتحساب میز ۳ را برای ۴ نفر مساوی تقسیم کن.",
      "انعام را هم در تقسیم حساب کن.",
    ],
  },
  {
    id: "custom",
    label: "سفارشی…",
    description: "هر وظیفه‌ای که می‌خواهید برای دستیار تعریف کنید",
    modes: ["dashboard", "floor"],
  },
];

const TASKS_BY_ID = new Map(AI_TASKS.map((task) => [task.id, task]));

export function taskById(id: string): AiTask | undefined {
  return TASKS_BY_ID.get(id as AiTaskId);
}

/**
 * Starter chips for an empty conversation. Per-task suggestions when the task
 * defines them, otherwise the surface's classic list.
 */
export function taskSuggestions(
  taskId: AiTaskId | undefined,
  mode: AgentMode,
  fallback: string[],
): string[] {
  const task = taskId ? taskById(taskId) : undefined;
  return task?.suggestions?.length ? task.suggestions : fallback;
}

/** Removes control characters and caps the length of a custom task description. */
export function sanitizeCustomTask(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CUSTOM_TASK_CHARS);
}

/**
 * The custom task frame: the safety rules stay absolute even when the owner
 * redefines the assistant's job for a conversation.
 */
export const CUSTOM_TASK_FRAME =
  "دستورالعمل موقتِ تعیین‌شده توسط کاربر برای همین گفتگو (همیشه رعایتش کن، اما قواعد ایمنی — تأیید دستی هر تغییر، منع جعل عدد و تاریخ، و ننوشتن شناسهٔ خام — بر آن مقدم‌اند):\n";

/**
 * Server-side resolution of one turn's task directive.
 *
 * A non-empty custom description wins over a preset id; an unknown id, an id
 * that does not belong to this mode, or a preset without a directive all
 * resolve to null (today's behaviour, untouched). Never throws — a garbage
 * `task` field is ignored, not fatal.
 */
export function taskDirectiveFor(input: {
  task?: unknown;
  customTask?: unknown;
  mode: AgentMode;
}): string | null {
  const custom =
    typeof input.customTask === "string" ? sanitizeCustomTask(input.customTask) : "";
  if (custom) return CUSTOM_TASK_FRAME + custom;

  const id = typeof input.task === "string" ? input.task : "general";
  const task = taskById(id);
  if (!task || !task.modes.includes(input.mode) || !task.directive) return null;
  return task.directive;
}
