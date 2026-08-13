"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ErrorBox, errorMessage as sharedErrorMessage } from "../ui";
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

export type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string; message?: string } }>,
) => Promise<boolean>;

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
  const [items, setItems] = useState<VariantRow[]>([]);
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
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      <nav
        aria-label="بخش‌های بدلیجات"
        className="rounded-2xl border border-stone-200/80 bg-white p-2 shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                id={`accessories-tab-${t.key}`}
                type="button"
                aria-pressed={isActive}
                aria-controls="accessories-tabpanel"
                onClick={() => setTab(t.key)}
                className={`min-h-[52px] rounded-xl border px-3 text-center text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-amber-400/40 sm:px-4 ${
                  isActive
                    ? "border-amber-200 bg-amber-100 text-amber-950 shadow-[0_1px_2px_rgb(120_53_15/0.08)]"
                    : "border-transparent bg-transparent text-stone-600 hover:border-stone-200 hover:bg-stone-50 hover:text-stone-950"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div
        id="accessories-tabpanel"
        role="region"
        aria-labelledby={`accessories-tab-${tab}`}
        className="min-w-0"
      >
        {tab === "items" ? <VariantsSection items={items} busy={busy} run={run} /> : null}
        {tab === "reports" ? <ReportsSection /> : null}
      </div>
    </div>
  );
}
