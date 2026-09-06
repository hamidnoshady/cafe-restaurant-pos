/**
 * What the technical Connections app can connect to, and who may set each one up.
 *
 * The dashboard once mixed the WordPress/WooCommerce store with technical
 * connections. The store kind remains in this compatibility catalogue because
 * older callers and URLs know its key, but it is not returned by
 * `visibleConnectionKinds`; WP Manager owns that connection and its workflows.
 * The technical connections the product supports are desktop, Holoo, the
 * website (Phase 38), API keys and MCP. This is the list they now share, kept pure so its visibility rules are unit
 * tested rather than asserted by reading JSX. It follows `settings-tabs.ts`'s
 * shape deliberately — same role/feature/module vocabulary — because it is the
 * same kind of decision.
 */
import type { Role } from "./auth";
import type { Industry } from "./industries";
import { hasModule } from "./industry-profile";

export const CONNECTION_KIND_KEYS = ["desktop", "woocommerce", "holoo", "website", "api", "mcp"] as const;
export type ConnectionKindKey = (typeof CONNECTION_KIND_KEYS)[number];

export interface ConnectionKind {
  key: ConnectionKindKey;
  label: string;
  /** One line under the tab heading: what this connection is for, in the owner's terms. */
  description: string;
  allowedRoles: Role[];
  /**
   * The flag that gates it, if any. A *lockable* flag does not hide the tab —
   * the tab renders a read-only preview, the same treatment the nav gives a
   * locked page — so this is "which entitlement does this need", not "hide me".
   */
  feature?: string;
}

export const CONNECTION_KINDS: ConnectionKind[] = [
  {
    key: "desktop",
    label: "برنامه دسکتاپ",
    description:
      "نصب برنامه روی رایانهٔ فروشگاه و اتصال آن به همین حساب ابری: آدرس این حساب و یک کد اتصال یک‌بارمصرف.",
    // Redeeming a code hands over a snapshot of the whole business, including
    // credential hashes. That is an owner's decision, like inviting a member.
    allowedRoles: ["owner"],
  },
  {
    key: "woocommerce",
    label: "فروشگاه ووکامرس",
    description:
      "اتصال دوطرفه به فروشگاه اینترنتی: سفارش، محصول، مشتری، موجودی و قیمت، با ثبت خودکار حسابداری.",
    allowedRoles: ["owner", "manager"],
    feature: "integrations",
  },
  {
    key: "holoo",
    label: "نرم‌افزار هلو",
    description:
      "اتصال به دیتابیس هلو برای مهاجرت یا کار در حالت همراه: اپ روی داده‌های خود هلو کار می‌کند در حالی که دفتر رسمی هلو می‌ماند.",
    allowedRoles: ["owner", "manager"],
    feature: "integrations",
  },
  {
    key: "website",
    label: "وب‌سایت",
    description:
      "اتصال وب‌سایت کسب‌وکار به همین حساب: پیش‌نویس مطلب و محصول از داده‌های واقعی، و ارسال یک‌طرفهٔ قیمت و موجودی به سایت.",
    // The site credential can create products and rewrite prices on a public
    // storefront; like the desktop and API tabs, that is an owner's decision.
    allowedRoles: ["owner"],
    feature: "integrations",
  },
  {
    key: "mcp",
    label: "دستیارهای هوش مصنوعی",
    description:
      "اتصال امن Claude، ChatGPT و دستیارهای مشابه به همین کسب‌وکار: پرسیدن از داده‌ها و — در صورت اجازهٔ شما — انجام تغییرها.",
    // Same reasoning as the two below: this hands a program continuous access
    // to a whole branch's orders, stock, customers and ledger, and (if the
    // owner grants it) the ability to change them. That is an owner's decision
    // in the same way inviting a member is.
    allowedRoles: ["owner"],
    feature: "api_platform",
  },
  {
    key: "api",
    label: "کلیدهای API",
    description:
      "کلید دسترسی برای برنامه‌هایی که خودتان یا توسعه‌دهنده‌تان روی داده‌های همین کسب‌وکار می‌سازید.",
    // Same reasoning as the desktop tab: a key is a long-lived machine
    // credential over a whole branch's data.
    allowedRoles: ["owner"],
    feature: "api_platform",
  },
];

export interface ConnectionKindVisibilityOptions {
  role: Role;
  /** Omitted where no business is in hand; then no module filtering applies. */
  industry?: Industry;
}

/**
 * Which tabs this member sees.
 *
 * Note what is *not* here: the feature flag. A tab whose entitlement is off
 * still renders — locked, as a preview — because these are things a business
 * buys, and a page that simply vanishes cannot tell anyone it exists. Role is
 * different: it is not a purchase, and a manager has no business being shown
 * an owner-only credential form at all.
 *
 * The industry module is `connections` for this technical hub, and it is a core
 * module every trade has — but it is checked rather than assumed, so that a
 * future profile which drops it drops this page with it. The separate
 * `integrations` module belongs to the WP Manager.
 */
export function visibleConnectionKinds(options: ConnectionKindVisibilityOptions): ConnectionKind[] {
  if (options.industry && !hasModule(options.industry, "connections")) return [];
  return CONNECTION_KINDS.filter(
    (kind) =>
      // Both website connections belong to «مدیریت وب‌سایت» (the WooCommerce
      // store to its WordPress manager, the platform site to its CMS manager),
      // so neither is drawn here — a business sets each one up inside the
      // manager that uses it, and this hub keeps the technical credentials.
      kind.key !== "woocommerce" &&
      kind.key !== "website" &&
      kind.allowedRoles.includes(options.role),
  );
}

export function isConnectionKindKey(value: string | null | undefined): value is ConnectionKindKey {
  return typeof value === "string" && (CONNECTION_KIND_KEYS as readonly string[]).includes(value);
}

/**
 * The tab to open, given whatever `?tab=` said and what this member can see.
 *
 * Falls back to the first visible tab rather than to a fixed default: an
 * unrecognised value, or one naming a tab this role cannot see, must not
 * produce an empty page.
 */
export function resolveConnectionKind(
  requested: string | null | undefined,
  visible: ConnectionKind[],
): ConnectionKindKey | null {
  if (visible.length === 0) return null;
  if (isConnectionKindKey(requested) && visible.some((kind) => kind.key === requested)) return requested;
  return visible[0].key;
}
