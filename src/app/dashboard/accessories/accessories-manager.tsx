"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage as sharedErrorMessage } from "../ui";
import { IndustryManagerShell, type Runner } from "../industry-manager-shell";
import { SectionCardSkeleton } from "../page-chrome";
import { VariantsSection } from "./variants-section";
import { ReportsSection } from "./reports-section";

export interface VariantRow {
  id: string;
  parentItemId: string | null;
  parentName: string | null;
  name: string;
  sku: string | null;
  kind: "variant_parent" | "variant_child";
  isActive: boolean;
  quantity: string;
  unitCost: number | null;
  unitPrice: number | null;
  attributes: { name: string; value: string }[];
}

export type { Runner } from "../industry-manager-shell";

function accessoriesErrorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    industry_mismatch: "این بخش فقط برای کسب‌وکارهای بدلیجات در دسترس است.",
    invalid_payment_method: "روش پرداخت نامعتبر است.",
    invalid_attributes: "ویژگی‌های تنوع معتبر نیست.",
  };
  return map[code ?? ""] ?? sharedErrorMessage(code);
}

const TABS = [
  { key: "items", label: "کالاها" },
  { key: "reports", label: "گزارش‌ها" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function AccessoriesManager() {
  const [items, setItems] = useState<VariantRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("items");

  useEffect(() => setError(""), [tab]);

  const load = useCallback(() => {
    api<{ items: VariantRow[] }>("/api/accessories/items").then(({ ok, data }) => {
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
      setError(data.message || accessoriesErrorMessage(data.error));
      return false;
    }
    load();
    return true;
  };

  return (
    <IndustryManagerShell
      idPrefix="accessories"
      navLabel="بخش‌های بدلیجات"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      error={error}
    >
      {tab === "items" ? (
        items === null ? <SectionCardSkeleton rows={5} /> : <VariantsSection items={items} busy={busy} run={run} />
      ) : null}
      {tab === "reports" ? <ReportsSection /> : null}
    </IndustryManagerShell>
  );
}
