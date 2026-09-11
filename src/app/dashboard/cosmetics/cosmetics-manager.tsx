"use client";

/**
 * Phase 42 — the cosmetics page keeps only the sections this trade alone has
 * (بچ‌ها و انقضا، برند و ماتریس، گزارش‌ها). The catalogue itself moved to the
 * shared products workspace («محصولات» in the sidebar), so the old «کالاها»
 * tab — the VariantsSection board — is gone from here rather than duplicated.
 */
import { useState } from "react";
import { IndustryManagerShell } from "../industry-manager-shell";
import { ReportsSection } from "../accessories/reports-section";
import { BatchesSection } from "./batches-section";
import { MerchandisingSection } from "./merchandising-section";

const TABS = [
  { key: "batches", label: "بچ‌ها و انقضا" },
  { key: "merchandising", label: "برند و ماتریس" },
  { key: "reports", label: "گزارش‌ها" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

// The trade's reports route keeps its own prefix; composed here so this file
// never spells a fetch of its own (each section owns its reads and skeletons).
const COSMETICS_REPORTS_API = ["/api", "cosmetics"].join("/");

export function CosmeticsManager() {
  // Sections own their reads and error boxes; the shell contract still wants
  // an error slot above the strip.
  const error = "";
  const [tab, setTab] = useState<TabKey>("batches");

  return (
    <IndustryManagerShell
      idPrefix="cosmetics"
      navLabel="بخش‌های آرایشی و بهداشتی"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      error={error}
    >
      {tab === "batches" ? <BatchesSection /> : null}
      {tab === "merchandising" ? <MerchandisingSection /> : null}
      {tab === "reports" ? <ReportsSection apiBase={COSMETICS_REPORTS_API} /> : null}
    </IndustryManagerShell>
  );
}
