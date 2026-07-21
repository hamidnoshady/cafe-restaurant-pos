"use client";

import { useState } from "react";
import { ReportBuilderSection } from "./report-builder-section";
import { StandardReportsSection } from "./standard-reports-section";

const TABS = [
  { key: "standard", label: "گزارش‌های آماده" },
  { key: "builder", label: "گزارش‌ساز" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function ReportsManager() {
  const [tab, setTab] = useState<TabKey>("standard");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {TABS.map((t) => (
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
    </div>
  );
}
