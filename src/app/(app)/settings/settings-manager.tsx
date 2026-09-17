"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BellIcon,
  BookOpenIcon,
  Building2Icon,
  CalendarClockIcon,
  CalculatorIcon,
  ClipboardCheckIcon,
  CloudCogIcon,
  CreditCardIcon,
  MonitorCogIcon,
  PanelTopIcon,
  PercentIcon,
  PrinterIcon,
  ShieldCheckIcon,
  StoreIcon,
  TagsIcon,
  UsersRoundIcon,
  type LucideIcon,
} from "lucide-react";
import type { ResolvedSettingsTab, SettingsTabKey } from "@/lib/settings-tabs";
import type { Industry } from "@/lib/industries";
import { settingsTabHref } from "@/lib/settings-routes";
import { SectionNav, type Section } from "@/app/dashboard/section-nav";
import { BackupManager } from "@/app/dashboard/backup/backup-manager";
import { BranchManagementSettings } from "./branch-management-settings";
import { TeamManager } from "@/app/dashboard/team/team-manager";
import { AccountsSettings } from "./accounts-settings";
import { AuditLogSettings } from "./audit-log-settings";
import { BusinessSettings } from "./business-settings";
import { DeviceSettings } from "./device-settings";
import { MenuSettings } from "./menu-settings";
import { NotificationSettings } from "./notification-settings";
import { OnlinePlatformsSettings } from "./online-platforms-settings";
import { PaymentMethodsSettings } from "./payment-methods-settings";
import { PricingSettings } from "./pricing-settings";
import { PrintingManager } from "./printing/printing-manager";
import { SecurityCenterSettings } from "./security-center-settings";
import { TwoFactorSettings } from "./two-factor-settings";
import { BusinessDaySettings } from "./business-day-settings";
import { ShiftHistorySettings } from "./shift-history-settings";
import { TaxSettings } from "./tax-settings";
import { cardClass } from "@/app/dashboard/page-chrome";

interface SettingsManagerProps {
  tabs: ResolvedSettingsTab[];
  /**
   * The section the URL asked for. Null at `/settings` itself, where the rail
   * opens on the first section a member may see (and, on a phone, on the list).
   */
  activeTab?: SettingsTabKey | null;
  features: Record<string, boolean>;
  currentUserId: string;
  isOwner: boolean;
  /** The business's trade, so sections whose wording/fields depend on it (tax) can adapt. */
  industry: Industry;
  /** The signed-in role, for the sections that mount a scoped party directory. */
  role: string;
  /**
   * The member's effective permission keys, so the sections that mount a
   * scoped party directory draw buttons the API will actually allow (see
   * `member-access.ts` and the section's own `permissions` prop).
   */
  permissions?: readonly string[];
}

const TAB_ICONS: Record<SettingsTabKey, LucideIcon> = {
  business: Building2Icon,
  tax: PercentIcon,
  pricing: TagsIcon,
  "online-platforms": PanelTopIcon,
  "payment-methods": CreditCardIcon,
  accounts: CalculatorIcon,
  team: UsersRoundIcon,
  menu: BookOpenIcon,
  printers: PrinterIcon,
  "branch-management": StoreIcon,
  devices: MonitorCogIcon,
  notifications: BellIcon,
  shifts: CalendarClockIcon,
  "audit-log": ClipboardCheckIcon,
  "security-center": ShieldCheckIcon,
  backup: CloudCogIcon,
};

// Every key must appear in exactly one group: the nav renders from this list,
// so a tab missing here is dropped from the sidebar without any type error.
const SETTINGS_GROUPS: Array<{ label: string; keys: SettingsTabKey[] }> = [
  { label: "کسب‌وکار", keys: ["business", "branch-management"] },
  { label: "مالی و فروش", keys: ["tax", "pricing", "payment-methods", "accounts"] },
  { label: "مدیریت", keys: ["team", "menu", "printers", "devices", "notifications", "shifts"] },
  { label: "امنیت و اتصال", keys: ["audit-log", "security-center", "backup"] },
  { label: "فروش آنلاین", keys: ["online-platforms"] },
];

/**
 * The platform settings area's sections.
 *
 * Each section is its own URL now (`/settings/team`, `/settings/printers` — see
 * `settings-routes.ts`) rather than a `?tab=` on one page, so the rail
 * *navigates* instead of switching local state: a member can bookmark the
 * section they live in, a guide can link straight to it, and the browser's back
 * button walks the sections the way it walks every other page in the product.
 *
 * `activeTab` therefore comes from the route, not from state. The drill-down's
 * open/closed flag is still local — it is a phone layout detail, not an address.
 */
export function SettingsManager({
  tabs,
  activeTab: activeTabProp,
  features,
  currentUserId,
  isOwner,
  industry,
  role,
  permissions,
}: SettingsManagerProps) {
  const router = useRouter();
  const firstTab = tabs[0]?.key;
  const available = useMemo(() => new Set(tabs.map((item) => item.key)), [tabs]);
  const sections = useMemo<Section<SettingsTabKey>[]>(
    () => tabs.map((item) => ({ key: item.key, label: item.label, icon: TAB_ICONS[item.key] })),
    [tabs],
  );

  // A phone opens straight into the section a URL named, and shows the list
  // when the URL is the settings home — the same drill-down as before, decided
  // by the address rather than by a click that may never have happened.
  const [open, setOpen] = useState(Boolean(activeTabProp));

  const goToTab = useCallback(
    (key: SettingsTabKey) => {
      setOpen(true);
      router.push(settingsTabHref(key));
    },
    [router],
  );

  if (!firstTab) return null;
  const activeTab =
    activeTabProp && available.has(activeTabProp) ? activeTabProp : firstTab;

  const tabsByKey = new Map(tabs.map((item) => [item.key, item]));
  const activeTabMeta = tabsByKey.get(activeTab);

  return (
    <SectionNav
      idPrefix="settings"
      label="بخش‌های تنظیمات"
      description="یک بخش را برای ویرایش انتخاب کنید."
      variant="rail"
      sections={sections}
      groups={SETTINGS_GROUPS}
      active={activeTab}
      onChange={goToTab}
      open={open}
      onOpenChange={setOpen}
    >
      {/*
        Hidden on a phone: the drill-down's back bar right above this already
        names the open section, so on a phone this card was the second of three
        headings stacked before the first field. From `md` up there is no back
        bar and this is the only thing naming the section.
      */}
      {activeTabMeta ? (
        <div className={`hidden ${cardClass} px-5 py-4 md:block`}>
          <div className="flex items-start gap-3">
            {(() => {
              const Icon = TAB_ICONS[activeTabMeta.key];
              return <Icon className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" />;
            })()}
            <div>
              <h2 className="font-bold text-foreground">{activeTabMeta.label}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{activeTabMeta.description}</p>
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === "business" ? <BusinessSettings /> : null}
      {activeTab === "tax" ? <TaxSettings industry={industry} /> : null}
      {activeTab === "pricing" ? <PricingSettings /> : null}
      {activeTab === "online-platforms" ? <OnlinePlatformsSettings /> : null}
      {activeTab === "payment-methods" ? <PaymentMethodsSettings /> : null}
      {activeTab === "accounts" ? <AccountsSettings /> : null}
      {activeTab === "team" ? (
        <TeamManager currentUserId={currentUserId} role={role} permissions={permissions} />
      ) : null}
      {activeTab === "menu" ? <MenuSettings /> : null}
      {activeTab === "printers" ? <PrintingManager /> : null}
      {activeTab === "branch-management" ? <BranchManagementSettings features={features} /> : null}
      {activeTab === "devices" ? <DeviceSettings /> : null}
      {activeTab === "notifications" ? <NotificationSettings /> : null}
      {activeTab === "shifts" ? (
        <div className="space-y-6">
          <BusinessDaySettings />
          <ShiftHistorySettings />
        </div>
      ) : null}
      {activeTab === "audit-log" ? <AuditLogSettings /> : null}
      {activeTab === "security-center" ? (
        <div className="space-y-6">
          {/* Phase 24 Wave 2 — two-factor enrolment for the signed-in
              owner/manager, plus the business's manager opt-in. Placed first
              because it is the one thing on this tab a grace-period nag sends
              somebody here to do. */}
          <TwoFactorSettings isOwner={isOwner} />
          <SecurityCenterSettings />
        </div>
      ) : null}
      {activeTab === "backup" ? <BackupManager isOwner={isOwner} /> : null}
    </SectionNav>
  );
}
