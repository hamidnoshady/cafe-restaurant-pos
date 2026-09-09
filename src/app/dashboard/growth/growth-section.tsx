"use client";

/**
 * Renders one Growth section by key (Phase 36b, revised).
 *
 * Each section is its own route now, so this is the single place that maps a
 * section key to its screen. The overview's quick actions used to drive an
 * in-page section switch; with real routes they navigate to the matching page
 * instead. The other sections need no props of their own.
 */

import { useRouter } from "next/navigation";
import { OverviewSection } from "./overview-section";
import { CampaignsSection } from "./campaigns-section";
import { GiftCardsSection } from "./gift-cards-section";
import { LoyaltySection } from "./loyalty-section";
import { CommissionSection } from "./commission-section";
import { GrowthCustomersSection } from "./customers-section";
import { growthSectionHref, type GrowthSectionKey } from "./growth-routes";

export function GrowthSection({ section, role }: { section: GrowthSectionKey; role: string }) {
  const router = useRouter();
  const goToSection = (key: GrowthSectionKey) => router.push(growthSectionHref(key));

  if (section === "overview") return <OverviewSection onGoToSection={goToSection} />;
  if (section === "customers") return <GrowthCustomersSection role={role} />;
  if (section === "campaigns") return <CampaignsSection />;
  if (section === "gift-cards") return <GiftCardsSection />;
  if (section === "loyalty") return <LoyaltySection />;
  return <CommissionSection />;
}
