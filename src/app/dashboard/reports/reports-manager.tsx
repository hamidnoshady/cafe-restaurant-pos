"use client";

import { useState } from "react";
import { BranchOverviewSection } from "./branch-overview-section";
import { ReportBuilderSection } from "./report-builder-section";
import { StandardReportsSection } from "./standard-reports-section";

const BASE_TABS = [
  { key: "standard", label: "گزارش‌های آماده" },
  { key: "builder", label: "گزارش‌ساز" },
] as const;
/** Owner-only: matches /api/reports/business-overview's guard. */
const BRANCH_TAB = { key: "branches", label: "مقایسهٔ شعب" } as const;

type TabKey = (typeof BASE_TABS)[number]["key"] | typeof BRANCH_TAB.key;

export function ReportsManager({ role }: { role: string }) {
  const [tab, setTab] = useState<TabKey>("standard");
  const tabs = role === "owner" ? [...BASE_TABS, BRANCH_TAB] : BASE_TABS;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === t.key ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "standard" ? <StandardReportsSection /> : null}
      {tab === "builder" ? <ReportBuilderSection /> : null}
      {tab === "branches" ? <BranchOverviewSection /> : null}
    </div>
  );
}
