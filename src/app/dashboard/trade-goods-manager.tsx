"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage as sharedErrorMessage } from "./ui";
import { IndustryManagerShell, type Runner } from "./industry-manager-shell";
import { VariantsSection } from "./accessories/variants-section";
import { ReportsSection } from "./accessories/reports-section";

export interface TradeGoodsVariantRow {
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

export type { Runner } from "./industry-manager-shell";

export function TradeGoodsManager({
  apiBase,
  idPrefix,
  navLabel,
  errorTitle,
}: {
  apiBase: string;
  idPrefix: string;
  navLabel: string;
  errorTitle: string;
}) {
  const [items, setItems] = useState<TradeGoodsVariantRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"items" | "reports">("items");

  useEffect(() => setError(""), [tab]);

  const load = useCallback(() => {
    api<{ items: TradeGoodsVariantRow[] }>(`${apiBase}/items`).then(({ ok, data }) => {
      if (ok) setItems(data.items);
    });
  }, [apiBase]);
  useEffect(load, [load]);

  const run: Runner = async (fn) => {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(data.message || tradeGoodsErrorMessage(errorTitle, data.error));
      return false;
    }
    load();
    return true;
  };

  return (
    <IndustryManagerShell
      idPrefix={idPrefix}
      navLabel={navLabel}
      tabs={[
        { key: "items", label: "کالاها" },
        { key: "reports", label: "گزارش‌ها" },
      ]}
      activeTab={tab}
      onTabChange={setTab}
      error={error}
    >
      {tab === "items" ? <VariantsSection items={items} busy={busy} run={run} apiBase={apiBase} /> : null}
      {tab === "reports" ? <ReportsSection apiBase={apiBase} /> : null}
    </IndustryManagerShell>
  );
}

function tradeGoodsErrorMessage(title: string, code: string | undefined): string {
  const map: Record<string, string> = {
    industry_mismatch: `این بخش فقط برای کسب‌وکارهای ${title} در دسترس است.`,
    invalid_payment_method: "روش پرداخت نامعتبر است.",
    invalid_attributes: "ویژگی‌های تنوع معتبر نیست.",
  };
  return map[code ?? ""] ?? sharedErrorMessage(code);
}
