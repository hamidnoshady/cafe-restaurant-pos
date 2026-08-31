"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage as sharedErrorMessage } from "../ui";
import { IndustryManagerShell, type Runner } from "../industry-manager-shell";
import { SectionCardSkeleton } from "../page-chrome";
import { VariantsSection } from "../accessories/variants-section";
import { ReportsSection } from "../accessories/reports-section";
import { BatchesSection } from "./batches-section";
import { MerchandisingSection } from "./merchandising-section";
import type { VariantRow } from "../accessories/accessories-manager";

export type { Runner } from "../industry-manager-shell";
export type { VariantRow } from "../accessories/accessories-manager";

function cosmeticsErrorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    industry_mismatch: "این بخش فقط برای کسب‌وکارهای آرایشی و بهداشتی در دسترس است.",
    invalid_payment_method: "روش پرداخت نامعتبر است.",
    invalid_attributes: "ویژگی‌های تنوع معتبر نیست.",
  };
  return map[code ?? ""] ?? sharedErrorMessage(code);
}

const TABS = [
  { key: "items", label: "کالاها" },
  { key: "batches", label: "بچ‌ها و انقضا" },
  { key: "merchandising", label: "برند و ماتریس" },
  { key: "reports", label: "گزارش‌ها" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function CosmeticsManager() {
  const [items, setItems] = useState<VariantRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("items");

  useEffect(() => setError(""), [tab]);

  const load = useCallback(() => {
    api<{ items: VariantRow[] }>("/api/cosmetics/items").then(({ ok, data }) => {
      if (ok) setItems(data.items);
    });
  }, []);
  useEffect(load, [load]);

  const run: Runner = async (fn) => {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(data.message || cosmeticsErrorMessage(data.error));
      return false;
    }
    load();
    return true;
  };

  return (
    <IndustryManagerShell
      idPrefix="cosmetics"
      navLabel="بخش‌های آرایشی و بهداشتی"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      error={error}
    >
      {tab === "items" ? (
        items === null ? (
          <SectionCardSkeleton rows={5} />
        ) : (
          <VariantsSection items={items} busy={busy} run={run} apiBase="/api/cosmetics" />
        )
      ) : null}
      {tab === "batches" ? <BatchesSection /> : null}
      {tab === "merchandising" ? <MerchandisingSection /> : null}
      {tab === "reports" ? <ReportsSection apiBase="/api/cosmetics" /> : null}
    </IndustryManagerShell>
  );
}
