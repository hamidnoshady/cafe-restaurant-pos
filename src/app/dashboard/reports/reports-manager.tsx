"use client";

import { useState } from "react";
import { SectionNav } from "../section-nav";
import { BranchOverviewSection } from "./branch-overview-section";
import { ReportBuilderSection } from "./report-builder-section";
import { ShiftOrdersSection } from "./shift-orders-section";
import { StandardReportsSection } from "./standard-reports-section";

const BASE_TABS = [
  { key: "standard", label: "گزارش‌های آماده" },
  { key: "shift-orders", label: "سفارش‌های شیفت" },
  { key: "builder", label: "گزارش‌ساز" },
] as const;
/** Owner-only: matches /api/reports/business-overview's guard. */
const BRANCH_TAB = { key: "branches", label: "مقایسهٔ شعب" } as const;

type TabKey = (typeof BASE_TABS)[number]["key"] | typeof BRANCH_TAB.key;

export function ReportsManager({ role, canExplain }: { role: string; canExplain: boolean }) {
  const [tab, setTab] = useState<TabKey>("standard");
  const tabs = role === "owner" ? [...BASE_TABS, BRANCH_TAB] : BASE_TABS;

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
      {tab === "branches" ? <BranchOverviewSection /> : null}
    </SectionNav>
  );
}
