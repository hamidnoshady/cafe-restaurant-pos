"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ResolvedSettingsTab, SettingsTabKey } from "@/lib/settings-tabs";
import { isSettingsTabKey } from "@/lib/settings-tabs";
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
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 border-b border-border pb-2" aria-label="بخش‌های تنظیمات">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            className={
              "rounded-lg px-3 py-1.5 text-sm " +
              (activeTab === item.key
                ? "bg-primary/10 font-semibold text-primary"
                : "text-muted-foreground hover:bg-muted")
            }
          >
            {item.label}
          </button>
        ))}
      </div>

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
    </div>
  );
}
