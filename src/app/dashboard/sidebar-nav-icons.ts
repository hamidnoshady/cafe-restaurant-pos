/**
 * One glyph per navigation href.
 *
 * Split out of `dashboard-sidebar.tsx` for the same reason
 * `sidebar-nav-styles.ts` was: an app's own nav component has to draw the
 * business pages it adopts (the Accounting workspace lists فاکتورها، انبار،
 * محصولات beside its ledger sections), and importing the shell that imports
 * the app would close a cycle. Two icon maps over one set of pages is how the
 * same page ends up with two faces.
 *
 * Keyed by href, because that is the stable identity of a page — the label is
 * the trade's word for it and changes per industry.
 */
import {
  ArmchairIcon,
  BarChart3Icon,
  BookOpenIcon,
  BotIcon,
  CalculatorIcon,
  CalendarDaysIcon,
  ChefHatIcon,
  ClipboardListIcon,
  ContactIcon,
  GemIcon,
  GlobeIcon,
  LayoutDashboardIcon,
  LifeBuoyIcon,
  PackageIcon,
  PlugIcon,
  SettingsIcon,
  ShoppingCartIcon,
  SparklesIcon,
  TrendingUpIcon,
  TruckIcon,
  UsersIcon,
  WalletIcon,
  WatchIcon,
  type LucideIcon,
} from "lucide-react";

export const NAV_ICONS: Record<string, LucideIcon> = {
  "/dashboard": LayoutDashboardIcon,
  "/dashboard/overview": LayoutDashboardIcon,
  "/dashboard/orders": ClipboardListIcon,
  "/dashboard/pos": ShoppingCartIcon,
  "/dashboard/persons": UsersIcon,
  "/dashboard/floor": ArmchairIcon,
  "/dashboard/waiter": ArmchairIcon,
  "/dashboard/kitchen": ChefHatIcon,
  "/dashboard/reservations": CalendarDaysIcon,
  "/dashboard/delivery": TruckIcon,
  "/dashboard/inventory": PackageIcon,
  // Phase 42 — the products workspace group's icon (nav entries derive theirs
  // from href; the group has none, so it names this key via `iconKey`).
  "/dashboard/products": PackageIcon,
  "/dashboard/jewelry": GemIcon,
  "/dashboard/watch": WatchIcon,
  "/dashboard/accessories": SparklesIcon,
  "/dashboard/wholesale": TruckIcon,
  "/dashboard/tools-fittings": PackageIcon,
  "/dashboard/haberdashery": SparklesIcon,
  "/dashboard/ledger": CalculatorIcon,
  // The Accounting app's own home (`/accounting`); the old ledger
  // address above still forwards into it, and keeps its glyph for any saved
  // bottom-nav slot that still points there.
  "/accounting": CalculatorIcon,
  // Each app's *home* is its overview, and the nav entry carries that exact
  // href — so the glyph has to be keyed on it too, or the app's own door falls
  // back to the generic circle.
  "/accounting/overview": CalculatorIcon,
  "/settings/connections": PlugIcon,
  "/dashboard/reports": BarChart3Icon,
  "/dashboard/ai": BotIcon,
  "/settings/billing": WalletIcon,
  "/settings": SettingsIcon,
  // Phase 36b — the Growth & Marketing app's home; the trend glyph the
  // workspace rail already uses for «رشد و بازاریابی».
  "/growth": TrendingUpIcon,
  "/growth/overview": TrendingUpIcon,
  // Phase 36 — the CRM app's home. `/dashboard/persons` keeps the plain
  // people glyph above; this is the app that now owns that record.
  "/crm": ContactIcon,
  "/crm/overview": ContactIcon,
  // «مدیریت وب‌سایت» — one app for both website systems (the Eshobe CMS site
  // builder and the WordPress/WooCommerce manager, each its own section).
  "/websites": GlobeIcon,
  "/websites/overview": GlobeIcon,
  // Migration 0130 — the support desk.
  "/dashboard/support": LifeBuoyIcon,
  // Migration 0131 — the in-product knowledge base («مرکز آموزش»).
  "/dashboard/knowledge": BookOpenIcon,
};
