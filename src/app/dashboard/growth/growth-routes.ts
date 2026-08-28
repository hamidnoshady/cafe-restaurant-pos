/**
 * The Growth & Marketing app's section routing (Phase 36b, revised).
 *
 * The app used to be one route with an in-page section rail. It is now a real
 * app with its own side menu and one page per section — the same shape the
 * accounting suite has — so each surface (overview, campaigns, gift cards,
 * loyalty, commission) is a route of its own under `/dashboard/growth`.
 *
 * These keys are the single source of truth for both the client side menu and
 * the server-side role gate: a cashier may open only `loyalty`, the one floor
 * surface the old flat pages gave them; the management dashboard and the
 * compensation data stay owner/manager, exactly the way the ledger's payroll
 * tab draws its line.
 */

export const GROWTH_SECTION_KEYS = [
  "overview",
  "campaigns",
  "gift-cards",
  "loyalty",
  "commission",
] as const;

export type GrowthSectionKey = (typeof GROWTH_SECTION_KEYS)[number];

/** The route for a section. The overview is the app root; the rest nest under it. */
export function growthSectionHref(key: GrowthSectionKey): string {
  return key === "overview" ? "/dashboard/growth" : `/dashboard/growth/${key}`;
}

/**
 * Whether a given role may open a section. The Growth app mirrors the
 * accounting suite's rule: compensation data (commission, the management
 * dashboard) is owner/manager, while loyalty is the one surface a cashier works
 * in.
 */
export function canViewGrowthSection(role: string, key: GrowthSectionKey): boolean {
  if (role === "cashier") return key === "loyalty";
  return ["owner", "manager"].includes(role);
}
