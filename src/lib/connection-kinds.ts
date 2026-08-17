/**
 * What a business can connect to, and who may set each one up.
 *
 * The dashboard used to have one page called «فروشگاه آنلاین» that could
 * connect to exactly one thing — a WooCommerce store — while the two other
 * connections the product actually supports were nowhere or elsewhere: the
 * desktop install had no self-service entry point at all (its pairing code was
 * issuable only from the super-admin console, which is how owners ended up
 * pasting a server-sync token into it), and the public API's keys, built in
 * Phase 19, had no screen to issue them from. Three connections, one of which
 * had a page.
 *
 * This is the list they now share, kept pure so its visibility rules are unit
 * tested rather than asserted by reading JSX. It follows `settings-tabs.ts`'s
 * shape deliberately — same role/feature/module vocabulary — because it is the
 * same kind of decision.
 */
import type { Role } from "./auth";
import type { Industry } from "./industries";
import { hasModule } from "./industry-profile";

export const CONNECTION_KIND_KEYS = ["desktop", "woocommerce", "api"] as const;
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
 * The industry module is `integrations` for every tab, and `integrations` is a
 * core module every trade has — but it is checked rather than assumed, so that
 * a future profile which drops it drops this page with it, the way every other
 * module-gated surface behaves.
 */
export function visibleConnectionKinds(options: ConnectionKindVisibilityOptions): ConnectionKind[] {
  if (options.industry && !hasModule(options.industry, "integrations")) return [];
  return CONNECTION_KINDS.filter((kind) => kind.allowedRoles.includes(options.role));
}

export function isConnectionKindKey(value: string | null | undefined): value is ConnectionKindKey {
  return typeof value === "string" && (CONNECTION_KIND_KEYS as readonly string[]).includes(value);
}

/**
 * The tab to open, given whatever `?tab=` said and what this member can see.
 *
 * Falls back to the first visible tab rather than to a fixed default: an
 * unrecognised value, or one naming a tab this role cannot see, must not
 * produce an empty page — and for a Manager (who sees only WooCommerce) the
 * "first visible" tab is the only sensible landing spot.
 */
export function resolveConnectionKind(
  requested: string | null | undefined,
  visible: ConnectionKind[],
): ConnectionKindKey | null {
  if (visible.length === 0) return null;
  if (isConnectionKindKey(requested) && visible.some((kind) => kind.key === requested)) return requested;
  return visible[0].key;
}
