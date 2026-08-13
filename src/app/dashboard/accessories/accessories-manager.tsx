"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ErrorBox, errorMessage as sharedErrorMessage } from "../ui";
import { VariantsSection } from "./variants-section";

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

export function AccessoriesManager() {
  const [items, setItems] = useState<VariantRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
      <VariantsSection items={items} busy={busy} run={run} />
    </div>
  );
}
