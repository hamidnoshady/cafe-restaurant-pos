"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ErrorBox, errorMessage as sharedErrorMessage } from "../ui";
import { ItemsSection } from "./items-section";
import { PricesSection } from "./prices-section";
import { ConsignorsSection } from "./consignors-section";

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
] as const;
type TabKey = (typeof TABS)[number]["key"];

export type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string; message?: string } }>,
) => Promise<boolean>;

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
  const [items, setItems] = useState<WeightItem[]>([]);
  const [prices, setPrices] = useState<GoldPriceRow[]>([]);
  const [consignors, setConsignors] = useState<Consignor[]>([]);
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
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      <nav
        aria-label="بخش‌های طلا و جواهر"
        className="rounded-2xl border border-stone-200/80 bg-white p-2 shadow-[0_1px_2px_rgb(41_37_36/0.03)]"
      >
        <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                id={`jewelry-tab-${t.key}`}
                type="button"
                aria-pressed={isActive}
                aria-controls="jewelry-tabpanel"
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
        id="jewelry-tabpanel"
        role="region"
        aria-labelledby={`jewelry-tab-${tab}`}
        className="min-w-0"
      >
        {tab === "items" ? (
          <ItemsSection items={items} prices={prices} consignors={consignors} busy={busy} run={run} />
        ) : null}
        {tab === "prices" ? <PricesSection prices={prices} busy={busy} run={run} /> : null}
        {tab === "consignors" ? <ConsignorsSection consignors={consignors} busy={busy} run={run} /> : null}
      </div>
    </div>
  );
}
