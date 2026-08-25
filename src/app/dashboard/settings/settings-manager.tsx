"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ResolvedSettingsTab, SettingsTabKey } from "@/lib/settings-tabs";
import { isSettingsTabKey } from "@/lib/settings-tabs";
import { TabBar, TabPanel } from "../page-chrome";
import { BackupManager } from "../backup/backup-manager";
import { BranchManagementSettings } from "./branch-management-settings";
import { TeamManager } from "../team/team-manager";
import { AccountsSettings } from "./accounts-settings";
import { AuditLogSettings } from "./audit-log-settings";
import { BusinessSettings } from "./business-settings";
import { DeviceSettings } from "./device-settings";
import { MenuSettings } from "./menu-settings";
import { NotificationSettings } from "./notification-settings";
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

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <TabBar idPrefix="settings" label="بخش‌های تنظیمات" tabs={tabs} active={activeTab} onChange={setTab} />

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
        {activeTab === "notifications" ? <NotificationSettings /> : null}
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
  );
}
