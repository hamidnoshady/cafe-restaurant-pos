"use client";

/**
 * Renders one Growth section by key (Phase 36b, revised).
 *
 * Each section is its own route now, so this is the single place that maps a
 * section key to its screen. The overview's quick actions used to drive an
 * in-page section switch; with real routes they navigate to the matching page
 * instead.
 *
 * Every key in `GROWTH_SECTION_KEYS` is handled here, and every page dispatches
 * through it. Three pages used to import their section component directly and
 * skip this file, which is how the dispatcher came to have a `commission`
 * fallback that would silently render the commission screen for any key nobody
 * had added a branch for — a missing section showing someone else's
 * compensation data. The `satisfies` record below makes a missing key a
 * compile error instead.
 */

import { useRouter } from "next/navigation";
import { OverviewSection } from "./overview-section";
import { CampaignsSection } from "./campaigns-section";
import { GiftCardsSection } from "./gift-cards-section";
import { LoyaltySection } from "./loyalty-section";
import { CommissionSection } from "./commission-section";
import { GrowthCustomersSection } from "./customers-section";
import { MessagingSection } from "./messaging-section";
import { GrowthSettingsSection } from "./settings-section";
import { growthSectionHref, type GrowthSectionKey } from "./growth-routes";

export function GrowthSection({
  section,
  role,
  /** The record a deep link (`/growth/customers?customer=…`) asks to open. */
  selectedCustomerId,
}: {
  section: GrowthSectionKey;
  role: string;
  selectedCustomerId?: string;
}) {
  const router = useRouter();
  const goToSection = (key: GrowthSectionKey) => router.push(growthSectionHref(key));
  const canManage = role === "owner" || role === "manager";

  const screens = {
    overview: () => <OverviewSection onGoToSection={goToSection} />,
    customers: () => (
      <GrowthCustomersSection role={role} selectedCustomerId={selectedCustomerId} />
    ),
    campaigns: () => <CampaignsSection />,
    messaging: () => <MessagingSection />,
    "gift-cards": () => <GiftCardsSection />,
    loyalty: () => <LoyaltySection canManage={canManage} />,
    commission: () => <CommissionSection />,
    settings: () => <GrowthSettingsSection />,
  } satisfies Record<GrowthSectionKey, () => React.ReactElement>;

  return screens[section]();
}
