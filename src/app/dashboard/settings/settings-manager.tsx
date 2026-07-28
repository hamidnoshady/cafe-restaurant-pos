"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { SettingsTab, SettingsTabKey } from "@/lib/settings-tabs";
import { isSettingsTabKey } from "@/lib/settings-tabs";
import { BackupManager } from "../backup/backup-manager";
import { LocationsManager } from "../locations/locations-manager";
import { TeamManager } from "../team/team-manager";
import { AccountsSettings } from "./accounts-settings";
import { BusinessSettings } from "./business-settings";
import { MenuSettings } from "./menu-settings";
import { PrinterSettings } from "./printer-settings";
import { ServerSyncSettings } from "./server-sync-settings";
import { TaxSettings } from "./tax-settings";

interface SettingsManagerProps {
  tabs: SettingsTab[];
  currentUserId: string;
  isOwner: boolean;
}

export function SettingsManager({ tabs, currentUserId, isOwner }: SettingsManagerProps) {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const firstTab = tabs[0]?.key;
  const [tab, setTab] = useState<SettingsTabKey>(() => tabs[0]?.key ?? "business");
  const available = useMemo(() => new Set(tabs.map((item) => item.key)), [tabs]);

  useEffect(() => {
    if (isSettingsTabKey(requestedTab) && available.has(requestedTab)) {
      setTab(requestedTab);
    }
  }, [available, requestedTab]);

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
      {activeTab === "accounts" ? <AccountsSettings /> : null}
      {activeTab === "team" ? <TeamManager currentUserId={currentUserId} /> : null}
      {activeTab === "menu" ? <MenuSettings /> : null}
      {activeTab === "printers" ? <PrinterSettings /> : null}
      {activeTab === "branch-sync" ? <LocationsManager /> : null}
      {activeTab === "server-sync" ? <ServerSyncSettings /> : null}
      {activeTab === "backup" ? <BackupManager isOwner={isOwner} /> : null}
    </div>
  );
}
