/**
 * The WordPress & WooCommerce Manager app's menu items.
 *
 * Framework-free (no React, no db) so the label/icon list can be unit-tested
 * and imported by both the app nav component and any surface that needs to
 * link into the app. Icons live in the nav component, same split Growth and
 * CRM use — this file answers "what sections exist and what are they called".
 */
import type { WpSectionKey } from "./wp-routes";

export interface WpNavItem {
  key: WpSectionKey;
  label: string;
  /** One line under the label in the rail/menu tooltips, if needed. */
  hint: string;
}

export function wpNavItemsForRole(_role: string): WpNavItem[] {
  return [
    { key: "overview", label: "میز کار", hint: "وضعیت اتصال و همگام‌سازی" },
    { key: "connections", label: "اتصال فروشگاه", hint: "ووکامرس و افزونهٔ وردپرس" },
    { key: "products", label: "محصولات", hint: "کالاهای همگام‌شده و عملیات فروشگاه" },
    { key: "orders", label: "سفارش‌ها", hint: "سفارش‌های آنلاین، وضعیت و برگشت وجه" },
    { key: "customers", label: "مشتریان فروشگاه", hint: "مشتریان همگام‌شده از فروشگاه" },
    { key: "taxonomies", label: "دسته‌بندی و ویژگی‌ها", hint: "درخت دسته‌بندی، برچسب و ویژگی‌ها" },
    { key: "content", label: "محتوا", hint: "نوشته‌ها و برگه‌های وردپرس" },
    { key: "media", label: "رسانه‌ها", hint: "کتابخانهٔ فایل‌های فروشگاه" },
    { key: "queue", label: "صف و رویدادها", hint: "کارهای در انتظار ارسال و خطاها" },
  ];
}
