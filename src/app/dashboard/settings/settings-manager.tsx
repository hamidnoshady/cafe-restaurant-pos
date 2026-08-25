"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  BookOpenIcon,
  Building2Icon,
  CalendarClockIcon,
  CalculatorIcon,
  ClipboardCheckIcon,
  CloudCogIcon,
  CreditCardIcon,
  MonitorCogIcon,
  NetworkIcon,
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
import { isSettingsTabKey } from "@/lib/settings-tabs";
import { TabPanel } from "../page-chrome";
import { BackupManager } from "../backup/backup-manager";
import { BranchManagementSettings } from "./branch-management-settings";
import { TeamManager } from "../team/team-manager";
import { AccountsSettings } from "./accounts-settings";
import { AuditLogSettings } from "./audit-log-settings";
import { BusinessSettings } from "./business-settings";
import { DeviceSettings } from "./device-settings";
import { MenuSettings } from "./menu-settings";
import { OnlinePlatformsSettings } from "./online-platforms-settings";
import { PaymentMethodsSettings } from "./payment-methods-settings";
import { PricingSettings } from "./pricing-settings";
import { PrinterSettings } from "./printer-settings";
import { SecurityCenterSettings } from "./security-center-settings";
import { ServerSyncSettings } from "./server-sync-settings";
import { BusinessDaySettings } from "./business-day-settings";
import { ShiftHistorySettings } from "./shift-history-settings";
import { TaxSettings } from "./tax-settings";

interface SettingsManagerProps {
  tabs: ResolvedSettingsTab[];
  features: Record<string, boolean>;
  currentUserId: string;
  isOwner: boolean;
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
  "server-sync": NetworkIcon,
  devices: MonitorCogIcon,
  shifts: CalendarClockIcon,
  "audit-log": ClipboardCheckIcon,
  "security-center": ShieldCheckIcon,
  backup: CloudCogIcon,
};

const SETTINGS_GROUPS: Array<{ label: string; keys: SettingsTabKey[] }> = [
  { label: "کسب‌وکار", keys: ["business", "branch-management"] },
  { label: "مالی و فروش", keys: ["tax", "pricing", "payment-methods", "accounts"] },
  { label: "مدیریت", keys: ["team", "menu", "printers", "devices", "shifts"] },
  { label: "امنیت و اتصال", keys: ["server-sync", "audit-log", "security-center", "backup"] },
  { label: "فروش آنلاین", keys: ["online-platforms"] },
];

export function SettingsManager({ tabs, features, currentUserId, isOwner }: SettingsManagerProps) {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const normalizedRequestedTab = requestedTab === "branch-sync" ? "branch-management" : requestedTab;
  const firstTab = tabs[0]?.key;
  const [tab, setTab] = useState<SettingsTabKey>(() => tabs[0]?.key ?? "business");
  const available = useMemo(() => new Set(tabs.map((item) => item.key)), [tabs]);

  useEffect(() => {
    if (isSettingsTabKey(normalizedRequestedTab) && available.has(normalizedRequestedTab)) {
      setTab(normalizedRequestedTab);
    }
  }, [available, normalizedRequestedTab]);

  if (!firstTab) return null;
  const activeTab = available.has(tab) ? tab : firstTab;

  const tabsByKey = new Map(tabs.map((item) => [item.key, item]));
  const activeTabMeta = tabsByKey.get(activeTab);

  return (
    <div className="flex min-w-0 flex-col gap-5 lg:flex-row lg:items-start lg:gap-6">
      <aside className="w-full shrink-0 lg:sticky lg:top-5 lg:w-[280px]" aria-label="منوی تنظیمات">
        <div className="overflow-hidden rounded-2xl border border-stone-200/80 bg-card shadow-[0_1px_2px_rgb(41_37_36/0.035)]">
          <div className="border-b border-stone-200/80 px-5 py-4">
            <h2 className="text-base font-bold text-stone-950">بخش‌های تنظیمات</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">یک بخش را برای ویرایش انتخاب کنید.</p>
          </div>
          <nav className="max-h-[calc(100vh-190px)] overflow-y-auto p-2" aria-label="بخش‌های تنظیمات">
            {SETTINGS_GROUPS.map((group) => {
              const groupTabs = group.keys.map((key) => tabsByKey.get(key)).filter(Boolean) as ResolvedSettingsTab[];
              if (groupTabs.length === 0) return null;
              return (
                <div key={group.label} className="mb-3 last:mb-0">
                  <p className="px-3 pb-1 pt-2 text-[11px] font-semibold tracking-wide text-stone-400">{group.label}</p>
                  <div className="space-y-0.5">
                    {groupTabs.map((item) => {
                      const Icon = TAB_ICONS[item.key];
                      const isActive = activeTab === item.key;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          aria-current={isActive ? "page" : undefined}
                          onClick={() => setTab(item.key)}
                          className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-right text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 ${
                            isActive
                              ? "bg-[#FFF1D8] font-semibold text-[#A96800]"
                              : "text-stone-600 hover:bg-stone-50 hover:text-stone-950"
                          }`}
                        >
                          <Icon className={`size-[18px] shrink-0 ${isActive ? "text-[#C27A00]" : "text-stone-400"}`} aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {isActive ? <span className="size-1.5 shrink-0 rounded-full bg-[#C27A00]" aria-hidden="true" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </nav>
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-4 sm:space-y-5">
        {activeTabMeta ? (
          <div className="rounded-2xl border border-stone-200/80 bg-card px-5 py-4 shadow-[0_1px_2px_rgb(41_37_36/0.025)]">
            <div className="flex items-start gap-3">
              {(() => {
                const Icon = TAB_ICONS[activeTabMeta.key];
                return <Icon className="mt-0.5 size-5 shrink-0 text-[#B97905]" aria-hidden="true" />;
              })()}
              <div>
                <h2 className="font-bold text-stone-950">{activeTabMeta.label}</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{activeTabMeta.description}</p>
              </div>
            </div>
          </div>
        ) : null}

        <TabPanel idPrefix="settings" active={activeTab}>
        {activeTab === "business" ? <BusinessSettings /> : null}
        {activeTab === "tax" ? <TaxSettings /> : null}
        {activeTab === "pricing" ? <PricingSettings /> : null}
        {activeTab === "online-platforms" ? <OnlinePlatformsSettings /> : null}
        {activeTab === "payment-methods" ? <PaymentMethodsSettings /> : null}
        {activeTab === "accounts" ? <AccountsSettings /> : null}
        {activeTab === "team" ? <TeamManager currentUserId={currentUserId} /> : null}
        {activeTab === "menu" ? <MenuSettings /> : null}
        {activeTab === "printers" ? <PrinterSettings /> : null}
        {activeTab === "branch-management" ? <BranchManagementSettings features={features} /> : null}
        {activeTab === "server-sync" ? <ServerSyncSettings /> : null}
        {activeTab === "devices" ? <DeviceSettings /> : null}
        {activeTab === "shifts" ? (
          <div className="space-y-6">
            <BusinessDaySettings />
            <ShiftHistorySettings />
          </div>
        ) : null}
        {activeTab === "audit-log" ? <AuditLogSettings /> : null}
        {activeTab === "security-center" ? <SecurityCenterSettings /> : null}
        {activeTab === "backup" ? <BackupManager isOwner={isOwner} /> : null}
        </TabPanel>
      </div>
    </div>
  );
}
