"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BranchesManager } from "../branches/branches-manager";
import { LocationsManager } from "../locations/locations-manager";
import { SectionNav } from "../section-nav";

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
    <section className="min-w-0 space-y-4 sm:space-y-5">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3 border-b border-border/80 pb-5 sm:mb-6 sm:pb-6">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت شعب</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-stone-950 dark:text-stone-100 sm:text-[1.7rem]">مدیریت شعب</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            ساختار شعب کسب‌وکار و همگام‌سازی داده‌های شعب را از یک بخش مدیریت کنید.
          </p>
        </div>
      </header>

      <SectionNav
        idPrefix="branch-management"
        label="بخش‌های مدیریت شعب"
        sections={availableTabs}
        active={activeTab}
        onChange={setTab}
      >
        {activeTab === "branches" ? <BranchesManager /> : null}
        {activeTab === "sync" ? <LocationsManager /> : null}
      </SectionNav>
    </section>
  );
}
