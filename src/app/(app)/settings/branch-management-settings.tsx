"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BranchesManager } from "@/app/dashboard/branches/branches-manager";
import { LocationsManager } from "@/app/dashboard/locations/locations-manager";
import { SectionNav } from "@/app/dashboard/section-nav";

type BranchManagementTabKey = "branches" | "sync";
type BranchFeatureKey = "multi_location" | "site_cloud_sync";

interface BranchManagementSettingsProps {
  features: Record<string, boolean>;
}

const BRANCH_MANAGEMENT_TABS: Array<{
  key: BranchManagementTabKey;
  label: string;
  requiredFeature: BranchFeatureKey;
}> = [
  { key: "branches", label: "مدیریت شعب", requiredFeature: "multi_location" },
  { key: "sync", label: "همگام‌سازی شعب", requiredFeature: "site_cloud_sync" },
];

function requestedBranchManagementTab(
  settingsTab: string | null,
  branchTab: string | null,
): BranchManagementTabKey | null {
  if (settingsTab === "branch-sync") return "sync";
  return branchTab === "branches" || branchTab === "sync" ? branchTab : null;
}

export function BranchManagementSettings({ features }: BranchManagementSettingsProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const availableTabs = useMemo(
    () => BRANCH_MANAGEMENT_TABS.filter((item) => features[item.requiredFeature]),
    [features],
  );
  const availableTabKeys = useMemo(() => availableTabs.map((item) => item.key), [availableTabs]);
  const requestedTab = requestedBranchManagementTab(searchParams.get("tab"), searchParams.get("branchTab"));
  const firstTab = availableTabKeys[0];
  const [tab, setTab] = useState<BranchManagementTabKey>(() => requestedTab ?? firstTab ?? "branches");

  /**
   * The phone drill-down. A deep link that *names* a tab (`?tab=branch-sync`,
   * `?branchTab=sync`) starts with the section open: the person followed a
   * link to «همگام‌سازی شعب», so landing them on a two-item menu they must
   * tap through again — with the tab already silently selected underneath —
   * read as the link being broken. Without a named tab the list is the page,
   * same as every other mobile settings menu.
   */
  const [open, setOpen] = useState(() => requestedTab !== null);

  /**
   * The `?branchTab=` the URL arrived with is honoured **once per value**, not
   * on every render.
   *
   * Re-applying it unconditionally made the two tabs unclickable whenever the
   * parameter was present: `/settings/branch-management?branchTab=sync` (which
   * is exactly where the legacy `/dashboard/locations` bookmark and the
   * `?tab=branch-sync` deep link land) set the tab to «همگام‌سازی شعب», and a
   * click on «مدیریت شعب» was immediately undone by the effect re-running —
   * the parameter never changes, so it won every time. Remembering which
   * request has already been applied lets the link still open the right tab
   * while leaving the tabs usable afterwards.
   */
  const appliedRequest = useRef<BranchManagementTabKey | null>(null);

  useEffect(() => {
    if (requestedTab && availableTabKeys.includes(requestedTab)) {
      if (appliedRequest.current !== requestedTab) {
        appliedRequest.current = requestedTab;
        setTab(requestedTab);
        // A request arriving after mount (client-side navigation to a deep
        // link) opens the phone drill-down too, for the same reason the
        // initial state does.
        setOpen(true);
      }
      return;
    }
    // A request for a tab this business cannot see (asking for «همگام‌سازی»
    // without `site_cloud_sync`) is not remembered, so it can't block the
    // fallback below from taking effect.
    appliedRequest.current = null;
    if (firstTab && !availableTabKeys.includes(tab)) {
      setTab(firstTab);
    }
  }, [availableTabKeys, firstTab, requestedTab, tab]);

  if (!firstTab) return null;
  const activeTab = availableTabKeys.includes(tab) ? tab : firstTab;

  /**
   * Switching tabs rewrites `?branchTab=`, so the address bar keeps naming the
   * section on screen — the tab is then shareable and survives a reload, which
   * is the whole reason the parameter is read in the first place. `replace`
   * rather than `push`: flipping between two tabs of one settings section
   * should not stack up history entries a person has to press Back through.
   */
  function selectTab(next: BranchManagementTabKey) {
    setTab(next);
    appliedRequest.current = next;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    params.set("branchTab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  // No header of its own: this renders *inside* the settings rail, which
  // already names the open section (SettingsManager's section card from `md`
  // up, the drill-down's back bar below it) under the page's one <h1>
  // («تنظیمات») from <PageHeader>. A second hand-rolled header here restated
  // PageHeader's spacing and put a duplicate <h1> in the document outline.

  // One visible tab is not a choice: rendering the SectionNav anyway gave a
  // phone a menu of exactly one row to tap through, and the desktop a strip
  // of one pill — both pure friction in front of the only content there is.
  if (availableTabs.length === 1) {
    return (
      <section className="min-w-0 space-y-4 sm:space-y-5">
        {activeTab === "branches" ? <BranchesManager /> : null}
        {activeTab === "sync" ? <LocationsManager /> : null}
      </section>
    );
  }

  return (
    <section className="min-w-0 space-y-4 sm:space-y-5">
      <SectionNav
        idPrefix="branch-management"
        label="بخش‌های مدیریت شعب"
        sections={availableTabs}
        active={activeTab}
        onChange={selectTab}
        open={open}
        onOpenChange={setOpen}
      >
        {activeTab === "branches" ? <BranchesManager /> : null}
        {activeTab === "sync" ? <LocationsManager /> : null}
      </SectionNav>
    </section>
  );
}
