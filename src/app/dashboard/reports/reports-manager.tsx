"use client";

import { useState } from "react";
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
  const panelId = "reports-workspace-panel";

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
        <div
          role="tablist"
          aria-label="بخش‌های گزارش‌ها"
          className="flex min-w-max gap-1 rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-1 sm:min-w-0 sm:w-fit"
        >
          {tabs.map((item) => {
            const selected = tab === item.key;
            return (
              <button
                key={item.key}
                id={"reports-tab-" + item.key}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId}
                onClick={() => setTab(item.key)}
                className={[
                  "min-h-[52px] shrink-0 rounded-lg px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45",
                  selected
                    ? "bg-[#FFF1D8] font-bold text-[#8A5C00] shadow-[0_1px_1px_rgb(66_47_14/0.06)]"
                    : "text-[#77756F] hover:bg-white hover:text-[#252522]",
                ].join(" ")}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <section
        id={panelId}
        role="tabpanel"
        aria-labelledby={"reports-tab-" + tab}
        className="min-w-0"
      >
        {tab === "standard" ? <StandardReportsSection canExplain={canExplain} /> : null}
        {tab === "shift-orders" ? <ShiftOrdersSection /> : null}
        {tab === "builder" ? <ReportBuilderSection /> : null}
        {tab === "branches" ? <BranchOverviewSection /> : null}
      </section>
    </div>
  );
}
