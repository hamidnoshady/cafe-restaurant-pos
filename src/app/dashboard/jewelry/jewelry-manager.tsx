"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage as sharedErrorMessage } from "../ui";
import { IndustryManagerShell, type Runner } from "../industry-manager-shell";
import { SectionCardSkeleton } from "../page-chrome";
import { ItemsSection } from "./items-section";
import { PricesSection } from "./prices-section";
import { ConsignorsSection } from "./consignors-section";
import { ReportsSection } from "./reports-section";

export type Purity = "18" | "21" | "24";
export type WeightItemStatus = "in_stock" | "reserved" | "sold";

export const PURITY_LABELS: Record<Purity, string> = {
  "18": "۱۸ عیار",
  "21": "۲۱ عیار",
  "24": "۲۴ عیار (طلای ۹۹۹)",
};

export const WEIGHT_ITEM_STATUS_LABELS: Record<WeightItemStatus, string> = {
  in_stock: "موجود",
  reserved: "رزرو شده",
  sold: "فروخته‌شده",
};

export interface WeightItem {
  id: string;
  name: string;
  sku: string | null;
  isActive: boolean;
  purity: Purity;
  grossWeight: string;
  netWeight: string;
  unitCostPerGram: string | null;
  status: WeightItemStatus;
  stoneCost: number;
  consignorId: string | null;
  consignorName: string | null;
}

export interface ItemStone {
  id: string;
  stoneType: string;
  carat: string;
  cost: number;
}

export interface GoldPriceRow {
  id: string;
  purity: Purity;
  priceDate: string;
  pricePerGram: number;
  source: "manual" | "external";
}

export interface Consignor {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
}

const TABS = [
  { key: "items", label: "کالاها" },
  { key: "prices", label: "نرخ طلا" },
  { key: "consignors", label: "امانت‌گذاران" },
  { key: "reports", label: "گزارش‌ها" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export type { Runner } from "../industry-manager-shell";

function jewelryErrorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    industry_mismatch: "این بخش فقط برای کسب‌وکارهای طلا و جواهر در دسترس است.",
    invalid_payment_method: "روش پرداخت نامعتبر است.",
    invalid_making_charge: "نوع اجرت نامعتبر است.",
    invalid_weight_attributes: "وزن یا عیار واردشده معتبر نیست.",
  };
  return map[code ?? ""] ?? sharedErrorMessage(code);
}

export function JewelryManager() {
  const [items, setItems] = useState<WeightItem[] | null>(null);
  const [prices, setPrices] = useState<GoldPriceRow[] | null>(null);
  const [consignors, setConsignors] = useState<Consignor[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("items");

  useEffect(() => setError(""), [tab]);

  const loadItems = useCallback(() => {
    api<{ items: WeightItem[] }>("/api/jewelry/items").then(({ ok, data }) => {
      if (ok) setItems(data.items);
    });
  }, []);
  useEffect(loadItems, [loadItems]);

  const loadPrices = useCallback(() => {
    api<{ prices: GoldPriceRow[] }>("/api/jewelry/prices").then(({ ok, data }) => {
      if (ok) setPrices(data.prices);
    });
  }, []);
  useEffect(loadPrices, [loadPrices]);

  const loadConsignors = useCallback(() => {
    api<{ consignors: Consignor[] }>("/api/jewelry/consignors").then(({ ok, data }) => {
      if (ok) setConsignors(data.consignors);
    });
  }, []);
  useEffect(loadConsignors, [loadConsignors]);

  const run: Runner = async (fn) => {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(data.message || jewelryErrorMessage(data.error));
      return false;
    }
    loadItems();
    loadPrices();
    loadConsignors();
    return true;
  };

  return (
    <IndustryManagerShell
      idPrefix="jewelry"
      navLabel="بخش‌های طلا و جواهر"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      error={error}
    >
      {tab === "items" ? (
        items === null || prices === null || consignors === null ? (
          <SectionCardSkeleton rows={5} />
        ) : (
          <ItemsSection items={items} prices={prices} consignors={consignors} busy={busy} run={run} />
        )
      ) : null}
      {tab === "prices" ? (
        prices === null ? <SectionCardSkeleton rows={4} /> : <PricesSection prices={prices} busy={busy} run={run} />
      ) : null}
      {tab === "consignors" ? (
        consignors === null ? (
          <SectionCardSkeleton rows={4} />
        ) : (
          <ConsignorsSection consignors={consignors} busy={busy} run={run} />
        )
      ) : null}
      {tab === "reports" ? <ReportsSection busy={busy} run={run} /> : null}
    </IndustryManagerShell>
  );
}
