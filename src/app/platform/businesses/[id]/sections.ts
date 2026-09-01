/**
 * The business workspace's sections — one source of truth for the sidebar
 * sub-menu in the console shell, the tab strip inside the workspace, and the
 * overview page's shortcut cards. Keeping the list here means a new section
 * appears in all three at once.
 *
 * `danger` only shows to operators who could actually act in it; the pages
 * themselves remain capability-checked on the server, this is UI honesty.
 */
import type { PlatformCapability } from "@/lib/platform-admin";

export interface BusinessSection {
  href: string;
  label: string;
  hint: string;
}

const SLUGS: {
  slug: string;
  label: string;
  hint: string;
  requires?: PlatformCapability[];
}[] = [
  { slug: "", label: "نمای کلی", hint: "خلاصهٔ وضعیت، مصرف و میان‌بُرهای بخش‌ها" },
  { slug: "settings", label: "تنظیمات", hint: "نام، منطقهٔ زمانی، نوع و نشانی اینترنتی" },
  { slug: "plan", label: "پلن و مصرف", hint: "اشتراک، سقف‌ها و آمار فعالیت" },
  { slug: "billing", label: "کیف پول و پرداخت", hint: "اعتبار، تراکنش‌ها، شارژ دستی و قابلیت‌های خریداری‌شده", requires: ["billing.manage"] },
  { slug: "features", label: "قابلیت‌ها و اتصال", hint: "پرچم‌های ویژگی و اتصال نسخهٔ دسکتاپ" },
  {
    slug: "support",
    label: "دسترسی پشتیبانی",
    hint: "ورود به‌عنوان کسب‌وکار (امپرسونات) و تاریخچهٔ آن",
  },
  {
    slug: "danger",
    label: "منطقهٔ خطر",
    hint: "ریست کامل داده‌ها و حذف قطعی کسب‌وکار",
    requires: ["business.reset", "business.delete"],
  },
];

export function businessSections(id: string, caps: PlatformCapability[]): BusinessSection[] {
  return SLUGS.filter((s) => !s.requires || s.requires.some((c) => caps.includes(c))).map((s) => ({
    href: s.slug ? `/platform/businesses/${id}/${s.slug}` : `/platform/businesses/${id}`,
    label: s.label,
    hint: s.hint,
  }));
}
