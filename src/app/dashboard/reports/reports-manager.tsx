"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SectionNav } from "../section-nav";
import { BranchOverviewSection } from "./branch-overview-section";
import { ReportBuilderSection } from "./report-builder-section";
import { ShiftOrdersSection } from "./shift-orders-section";
import { StandardReportsSection } from "./standard-reports-section";
import { GrowthAccountingView } from "@/components/growth/growth-accounting-view";
import { isReportsTabKey, reportsTabsForRole, type ReportsTabKey } from "./reports-nav";

export function ReportsManager({ role, canExplain }: { role: string; canExplain: boolean }) {
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const tabs = reportsTabsForRole(role);

  // The phone shows the section list first; a `?tab=` link asked for one
  // section by name, so that link opens it rather than the list around it.
  const [tab, setTab] = useState<ReportsTabKey>(() =>
    isReportsTabKey(requestedTab) ? requestedTab : "standard",
  );

  // Follow client-side navigations that only changed the query string.
  useEffect(() => {
    if (isReportsTabKey(requestedTab)) setTab(requestedTab);
  }, [requestedTab]);

  return (
    <SectionNav
      idPrefix="reports"
      label="بخش‌های گزارش‌ها"
      sections={tabs}
      active={tab}
      onChange={setTab}
      className="space-y-5 sm:space-y-6"
    >
      {tab === "standard" ? <StandardReportsSection canExplain={canExplain} /> : null}
      {tab === "shift-orders" ? <ShiftOrdersSection /> : null}
      {tab === "builder" ? <ReportBuilderSection /> : null}
      {tab === "growth" ? <GrowthAccountingView /> : null}
      {tab === "branches" ? <BranchOverviewSection /> : null}
    </SectionNav>
  );
}
