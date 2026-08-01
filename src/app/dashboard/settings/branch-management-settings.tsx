"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BranchesManager } from "../branches/branches-manager";
import { LocationsManager } from "../locations/locations-manager";

type BranchManagementTabKey = "branches" | "sync";
type BranchFeatureKey = "multi_location" | "offline_mode";

interface BranchManagementSettingsProps {
  features: Record<string, boolean>;
}

const BRANCH_MANAGEMENT_TABS: Array<{
  key: BranchManagementTabKey;
  label: string;
  requiredFeature: BranchFeatureKey;
}> = [
  { key: "branches", label: "مدیریت شعب", requiredFeature: "multi_location" },
  { key: "sync", label: "همگام‌سازی شعب", requiredFeature: "offline_mode" },
];

function requestedBranchManagementTab(
  settingsTab: string | null,
  branchTab: string | null,
): BranchManagementTabKey | null {
  if (settingsTab === "branch-sync") return "sync";
  return branchTab === "branches" || branchTab === "sync" ? branchTab : null;
}

export function BranchManagementSettings({ features }: BranchManagementSettingsProps) {
  const searchParams = useSearchParams();
  const availableTabs = useMemo(
    () => BRANCH_MANAGEMENT_TABS.filter((item) => features[item.requiredFeature]),
    [features],
  );
  const availableTabKeys = useMemo(() => availableTabs.map((item) => item.key), [availableTabs]);
  const requestedTab = requestedBranchManagementTab(searchParams.get("tab"), searchParams.get("branchTab"));
  const firstTab = availableTabKeys[0];
  const [tab, setTab] = useState<BranchManagementTabKey>(() => requestedTab ?? firstTab ?? "branches");

  useEffect(() => {
    if (requestedTab && availableTabKeys.includes(requestedTab)) {
      setTab(requestedTab);
      return;
    }
    if (firstTab && !availableTabKeys.includes(tab)) {
      setTab(firstTab);
    }
  }, [availableTabKeys, firstTab, requestedTab, tab]);

  if (!firstTab) return null;
  const activeTab = availableTabKeys.includes(tab) ? tab : firstTab;

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">مدیریت شعب</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          ساختار شعب کسب‌وکار و همگام‌سازی داده‌های شعب را از یک بخش مدیریت کنید.
        </p>
      </header>

      <div
        className="flex flex-wrap gap-2 border-b border-border pb-2"
        role="tablist"
        aria-label="بخش‌های مدیریت شعب"
      >
        {availableTabs.map((item) => {
          const selected = activeTab === item.key;
          return (
            <button
              key={item.key}
              id={`branch-management-tab-${item.key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`branch-management-panel-${item.key}`}
              onClick={() => setTab(item.key)}
              className={
                "rounded-lg px-3 py-1.5 text-sm " +
                (selected
                  ? "bg-primary/10 font-semibold text-primary"
                  : "text-muted-foreground hover:bg-muted")
              }
            >
              {item.label}
            </button>
          );
        })}
      </div>

      <div
        id={`branch-management-panel-${activeTab}`}
        role="tabpanel"
        aria-labelledby={`branch-management-tab-${activeTab}`}
      >
        {activeTab === "branches" ? <BranchesManager /> : null}
        {activeTab === "sync" ? <LocationsManager /> : null}
      </div>
    </section>
  );
}
