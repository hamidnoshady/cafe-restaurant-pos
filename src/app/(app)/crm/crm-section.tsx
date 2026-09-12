"use client";

/**
 * Renders one CRM section by key (Phase 36).
 *
 * Each section is its own route, so this is the single place that maps a
 * section key to its screen — the same arrangement `growth-section.tsx` uses.
 * The overview's quick actions navigate rather than switching an in-page tab,
 * because the sections are real pages with real URLs a person can bookmark.
 */

import { useRouter } from "next/navigation";
import { CrmOverviewSection } from "./overview-section";
import { DirectorySection } from "./directory-section";
import { SegmentsSection } from "./segments-section";
import { DealsSection } from "./deals-section";
import { ActivitiesSection } from "./activities-section";
import { CasesSection } from "./cases-section";
import { DuplicatesSection } from "./duplicates-section";
import { ConsentSection } from "./consent-section";
import { CrmSettingsSection } from "./settings-section";
import { crmSectionHref, type CrmSectionKey } from "./crm-routes";

export function CrmSection({ section, role }: { section: CrmSectionKey; role: string }) {
  const router = useRouter();
  const goToSection = (key: CrmSectionKey) => router.push(crmSectionHref(key));

  if (section === "overview") return <CrmOverviewSection onGoToSection={goToSection} />;
  if (section === "directory") return <DirectorySection role={role} />;
  if (section === "segments") return <SegmentsSection />;
  if (section === "deals") return <DealsSection />;
  if (section === "activities") return <ActivitiesSection />;
  if (section === "cases") return <CasesSection />;
  if (section === "duplicates") return <DuplicatesSection />;
  if (section === "settings") return <CrmSettingsSection />;
  return <ConsentSection />;
}
