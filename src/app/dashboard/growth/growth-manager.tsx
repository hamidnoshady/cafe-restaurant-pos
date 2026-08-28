"use client";

/**
 * The Growth & Marketing app's workspace (Phase 36b).
 *
 * The accounting suite set the pattern — one route, a rail of sections, every
 * section a screen with its own data (`ledger-manager.tsx`). This is the same
 * shape over the marketing side of the business: a management dashboard that
 * answers «بازاریابی‌ام چه خبر؟», and one section per engine. Nothing was
 * rewritten to get here — each section calls the same APIs the three flat
 * pages called, and every write still lands in the ledger through the posting
 * rules those pages already used.
 *
 * The rail restricts itself by role rather than the route refusing: a cashier
 * enters the app on the loyalty section (the one surface the old
 * /dashboard/loyalty page gave them) and never sees commission — compensation
 * data — or the dashboard, exactly the way the ledger drops its payroll tab
 * for a manager.
 */

import { useCallback, useState } from "react";
import { CreditCardIcon, HandCoinsIcon, HeartIcon, MegaphoneIcon, TrendingUpIcon } from "lucide-react";
import { SectionNav, type Section } from "../section-nav";
import { OverviewSection } from "./overview-section";
import { CampaignsSection } from "./campaigns-section";
import { GiftCardsSection } from "./gift-cards-section";
import { LoyaltySection } from "./loyalty-section";
import { CommissionSection } from "./commission-section";
import type { GrowthSectionKey } from "./growth-sections";

export const GROWTH_SECTIONS: readonly Section<GrowthSectionKey>[] = [
  {
    key: "overview",
    label: "میز کار رشد",
    description: "اعداد کلیدی، رویدادها و پل حسابداری",
    icon: TrendingUpIcon,
  },
  {
    key: "campaigns",
    label: "کمپین‌ها",
    description: "موتور تخفیف و اثربخشی هر کمپین",
    icon: MegaphoneIcon,
  },
  {
    key: "gift-cards",
    label: "کارت هدیه",
    description: "صدور و مصرف؛ بدهی واقعی ۲۴۲۰",
    icon: CreditCardIcon,
  },
  {
    key: "loyalty",
    label: "وفاداری و اعتبار",
    description: "امتیاز، اعتبار فروشگاهی و خرید مجدد",
    icon: HeartIcon,
  },
  {
    key: "commission",
    label: "پورسانت فروشندگان",
    description: "قواعد و رتبه‌بندی؛ بدهی حقوق ۲۳۰۰",
    icon: HandCoinsIcon,
  },
] as const;

export function GrowthManager({ role, initialSection }: { role: string; initialSection: GrowthSectionKey }) {
  // Compensation data is owner/manager, the same line the ledger's payroll
  // tab draws; the dashboard aggregates it, so it draws the same line.
  const isManagerLevel = role === "owner" || role === "manager";
  const sections = GROWTH_SECTIONS.filter((section) => isManagerLevel || section.key === "loyalty");
  // A deep link the role cannot use (?section=commission as a cashier) lands
  // on the first section that role does have, not on an empty panel.
  const allowed = sections.some((s) => s.key === initialSection);
  const [section, setSection] = useState<GrowthSectionKey>(allowed ? initialSection : sections[0].key);

  // Keep the address bar honest without navigating: a section opened from the
  // overview's quick actions, or from an old /dashboard/loyalty deep link, is
  // shareable as /dashboard/growth?section=… and a refresh keeps its place.
  const changeSection = useCallback((next: GrowthSectionKey) => {
    setSection(next);
    try {
      window.history.replaceState(null, "", `/dashboard/growth?section=${next}`);
    } catch {
      // A browser that refuses replaceState still gets the section; only the
      // address bar is stale, never the screen.
    }
  }, []);

  return (
    <SectionNav
      idPrefix="growth"
      label="بخش‌های رشد و بازاریابی"
      title="برنامهٔ رشد و بازاریابی"
      description="کمپین‌ها، کارت هدیه، وفاداری و پورسانت — با اتصال خودکار به حسابداری"
      variant="rail"
      sections={sections}
      active={section}
      onChange={changeSection}
    >
      <div className="min-w-0">
        {section === "overview" ? <OverviewSection onGoToSection={changeSection} /> : null}
        {section === "campaigns" ? <CampaignsSection /> : null}
        {section === "gift-cards" ? <GiftCardsSection /> : null}
        {section === "loyalty" ? <LoyaltySection /> : null}
        {section === "commission" ? <CommissionSection /> : null}
      </div>
    </SectionNav>
  );
}
