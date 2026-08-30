"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Phase 25 Wave 3 — the retail industries' selling screen.
 *
 * The café POS sells `menu_items` from a category grid; a jewellery shop has
 * none, so `/dashboard/pos` branches on `salesModel` (see page.tsx) and lands
 * here instead. What a shop counter does is build up a few priced lines for one
 * customer and settle them together — so this is a cart over the industry's own
 * catalogue, and it posts one invoice.
 *
 * Every line's price comes from the pricing module Phase 21 already wrote for
 * that trade, and the server settles each line through the same sell service
 * the per-item panel always used (retail-invoice-service.ts). Nothing here
 * computes a ledger amount; the totals shown are the ones the server will
 * confirm back.
 */
import { useCallback, useEffect, useMemo, useState, useDeferredValue } from "react";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { formatPersianNumber, formatQuantity, toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { normalizePosSearchText } from "@/lib/pos-selection";
import { computeGoldSalePrice, type MakingChargeType } from "@/lib/gold-pricing";
import { computeAccessorySalePrice } from "@/lib/accessories";
import { computeCosmeticSalePrice } from "@/lib/cosmetics";
import { computeWatchSalePrice } from "@/lib/watch-pricing";
import { hasCapability, labelFor } from "@/lib/industry-profile";
import { isTradeGoodsIndustry } from "@/lib/trade-goods";
import type { Industry } from "@/lib/industries";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CameraScanTrigger } from "@/components/scanner/camera-barcode-scanner";
import { ledgerSettlementFor } from "@/lib/payment-methods";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { usePaymentMethods } from "../payment-ways";
import { PageHeader, PageShell } from "../page-chrome";
import { KnowledgeHelpButton } from "../knowledge-help";

type Purity = "18" | "21" | "24";

interface WeightItem {
  id: string;
  name: string;
  sku: string | null;
  purity: Purity;
  netWeight: string;
  status: string;
  stoneCost: number;
}

interface GoldPrice {
  purity: Purity;
  priceDate: string;
  pricePerGram: number;
}

interface SerialUnit {
  id: string;
  itemId: string;
  itemName: string;
  serialNumber: string;
  status: string;
  warrantyMonths: number;
}

interface Variant {
  id: string;
  parentName: string | null;
  name: string;
  sku: string | null;
  kind: string;
  quantity: string;
  /** Cosmetics batch-tracked items: the sellable (non-expired) quantity. */
  sellableQuantity?: string;
  tracking?: string;
  unitPrice: number | null;
}

interface Customer {
  id: string;
  name: string;
}

interface InvoiceSummary {
  id: string;
  orderNumber: number;
  total: number;
  closedAt: string;
  customerName: string | null;
  lineCount: number;
}

/** One line in the cart, before it is sent. Prices are previews of what the server will compute. */
interface CartLine {
  key: string;
  label: string;
  /** Discriminates which payload shape goes to the API. */
  payload: Record<string, unknown> & { kind: "gold" | "watch" | "accessory" | "cosmetic" | "stocked" };
  net: number;
  vat: number;
  total: number;
  /** Gold only, for the preview breakdown. */
  parts?: { metalValue: number; makingCharge: number; profit: number };
}


const PURITY_LABELS: Record<Purity, string> = {
  "18": "۱۸ عیار",
  "21": "۲۱ عیار",
  "24": "۲۴ عیار",
};

/**
 * The variant-catalogue API for a trade-goods/variant retail industry. These
 * all share the same board shape (families + variants with item_stock), so the
 * POS loads them through the same client code; only the URL namespace differs.
 */
function variantApiFor(industry: Industry): string | null {
  switch (industry) {
    case "accessories":
      return "/api/accessories";
    case "cosmetics":
      return "/api/cosmetics";
    case "wholesale":
      return "/api/wholesale";
    case "tools_fittings":
      return "/api/tools-fittings";
    case "haberdashery":
      return "/api/haberdashery";
    default:
      return null;
  }
}

function newKey(): string {
  return crypto.randomUUID();
}

export function RetailInvoiceScreen({ industry }: { industry: Industry }) {
  const money = useMoney();
  const [weightItems, setWeightItems] = useState<WeightItem[]>([]);
  const [prices, setPrices] = useState<GoldPrice[]>([]);
  const [units, setUnits] = useState<SerialUnit[]>([]);
  const [variants, setVariants] = useState<Variant[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<InvoiceSummary[]>([]);

  const [lines, setLines] = useState<CartLine[]>([]);
  const [customerId, setCustomerId] = useState("");
  // The business's own payment ways (migration 0091) rather than three fixed
  // buttons — so a shop that renamed «کارت‌خوان» to «پوز ملت» reads its own
  // name here too. A retail invoice still settles *one* way: it posts through
  // the domain-event engine per line, which knows one destination per sale,
  // so `ledgerSettlementFor` narrows the chosen way to what that engine
  // understands. Splitting a bill is the order path's (see PaymentWays).
  const { methods: paymentWays } = usePaymentMethods();
  const settlementWays = paymentWays.filter((way) => ledgerSettlementFor(way.settlement) !== null);
  const [paymentWayId, setPaymentWayId] = useState("");
  const selectedWay = settlementWays.find((way) => way.id === paymentWayId) ?? settlementWays[0];
  const paymentMethod = selectedWay ? (ledgerSettlementFor(selectedWay.settlement) ?? "cash") : "cash";
  const [note, setNote] = useState("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ orderNumber: number; total: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const requests: Promise<unknown>[] = [
      api<{ customers?: Customer[] }>("/api/customers").then(({ ok, data }) => {
        if (ok) setCustomers(data.customers ?? []);
      }),
      api<{ invoices?: InvoiceSummary[] }>("/api/sales/invoices?limit=20").then(({ ok, data }) => {
        if (ok) setInvoices(data.invoices ?? []);
      }),
    ];
    if (industry === "jewelry") {
      requests.push(
        api<{ items?: WeightItem[] }>("/api/jewelry/items").then(({ ok, data }) => {
          if (ok) setWeightItems(data.items ?? []);
        }),
        api<{ prices?: GoldPrice[] }>("/api/jewelry/prices").then(({ ok, data }) => {
          if (ok) setPrices(data.prices ?? []);
        }),
      );
    }
    if (industry === "watch") {
      requests.push(
        api<{ units?: SerialUnit[] }>("/api/watch/units").then(({ ok, data }) => {
          if (ok) setUnits(data.units ?? []);
        }),
      );
    }
    const variantApi = variantApiFor(industry);
    if (variantApi) {
      requests.push(
        api<{ items?: Variant[] }>(`${variantApi}/items`).then(({ ok, data }) => {
          if (ok) setVariants(data.items ?? []);
        }),
      );
    }
    await Promise.all(requests);
    setLoading(false);
  }, [industry]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(
    () =>
      lines.reduce(
        (acc, l) => ({ net: acc.net + l.net, vat: acc.vat + l.vat, total: acc.total + l.total }),
        { net: 0, vat: 0, total: 0 },
      ),
    [lines],
  );

  function addLine(line: CartLine) {
    setDone(null);
    setError(null);
    setLines((current) => [...current, line]);
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((l) => l.key !== key));
  }

  async function submit() {
    if (lines.length === 0) return;
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{
      invoice?: { orderNumber: number; total: string };
      error?: string;
      message?: string;
    }>("/api/sales/invoices", {
      method: "POST",
      body: JSON.stringify({
        lines: lines.map((l) => l.payload),
        paymentMethod,
        customerId: customerId || null,
        note: note.trim() || null,
      }),
    });
    setBusy(false);
    if (ok && data.invoice) {
      setDone({ orderNumber: data.invoice.orderNumber, total: Number(data.invoice.total) });
      setLines([]);
      setCustomerId("");
      setNote("");
      void load();
    } else {
      // The server sends the sell services' own Persian refusals (no stock, no
      // cost basis, no gold rate recorded for today) as `message`; showing that
      // is far more useful than a generic failure.
      setError(data.message ?? "ثبت فاکتور ناموفق بود.");
    }
  }

  return (
    <PageShell>
      <PageHeader
        title={labelFor(industry, "sellScreen")}
        description="کالاها را به فاکتور اضافه کنید، مشتری و روش پرداخت را انتخاب کنید و فاکتور را ثبت کنید."
        actions={
          <>
            <KnowledgeHelpButton section="pos" />
            <Button variant="outline" onClick={() => void load()} disabled={loading || busy}>
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              به‌روزرسانی
            </Button>
          </>
        }
      />

      <ErrorBox>{error}</ErrorBox>
      {done ? (
        <div className="mb-4 rounded-xl border border-emerald-300/60 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          فاکتور شمارهٔ {toPersianDigits(done.orderNumber)} به مبلغ {money.format(done.total)} ثبت شد.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
        <div className="min-w-0 space-y-4">
          {hasCapability(industry, "barcode") ? (
            <BarcodeScanField
              industry={industry}
              variants={variants}
              weightItems={weightItems}
              prices={prices}
              units={units}
              onAdd={addLine}
            />
          ) : null}
          {industry === "jewelry" ? (
            <GoldLineForm items={weightItems} prices={prices} onAdd={addLine} />
          ) : null}
          {industry === "watch" ? <WatchLineForm units={units} onAdd={addLine} /> : null}
          {industry === "accessories" ? <AccessoryLineForm variants={variants} onAdd={addLine} kind="accessory" /> : null}
          {industry === "cosmetics" ? <CosmeticsLineForm variants={variants} onAdd={addLine} /> : null}
          {isTradeGoodsIndustry(industry) ? <AccessoryLineForm variants={variants} onAdd={addLine} kind="stocked" /> : null}

          <RecentInvoices invoices={invoices} loading={loading} />
        </div>

        <aside className="min-w-0">
          <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] lg:sticky lg:top-4 sm:p-5">
            <h2 className="font-semibold text-stone-950">فاکتور جاری</h2>

            {lines.length === 0 ? (
              <p className="mt-4 rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">
                هنوز کالایی اضافه نشده است.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-stone-200/80">
                {lines.map((line) => (
                  <li key={line.key} className="py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-stone-950">{line.label}</p>
                        {line.parts ? (
                          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
                            طلا {money.format(line.parts.metalValue)} · اجرت{" "}
                            {money.format(line.parts.makingCharge)} · سود {money.format(line.parts.profit)}
                          </p>
                        ) : null}
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          مالیات {money.format(line.vat)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-sm font-semibold text-stone-950">
                          {money.format(line.total)}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeLine(line.key)}
                          className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs text-rose-700 hover:bg-rose-50"
                          aria-label={`حذف ${line.label}`}
                        >
                          <Trash2Icon aria-hidden="true" className="size-3.5" />
                          حذف
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <dl className="mt-4 space-y-1.5 border-t border-stone-200/80 pt-4 text-sm">
              <Row label="جمع جزء" value={money.format(totals.net)} />
              <Row label="مالیات" value={money.format(totals.vat)} />
              <Row label="جمع کل" value={money.format(totals.total)} strong />
            </dl>

            <div className="mt-4">
              <Field label="مشتری">
                <SearchableSelect
                  value={customerId}
                  onChange={setCustomerId}
                  ariaLabel="انتخاب مشتری"
                  options={[
                    { value: "", label: "بدون مشتری" },
                    ...customers.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              </Field>
              <Field label="روش پرداخت">
                <div className="flex flex-wrap gap-2">
                  {settlementWays.map((way) => (
                    <button
                      key={way.id}
                      type="button"
                      onClick={() => setPaymentWayId(way.id)}
                      className={`min-h-11 flex-1 rounded-xl border px-3 text-sm transition-colors ${
                        selectedWay?.id === way.id
                          ? "border-amber-500 bg-amber-50 font-medium text-amber-900"
                          : "border-stone-200 text-stone-700 hover:border-amber-300"
                      }`}
                    >
                      {way.name}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="توضیح">
                <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>

            <Button
              onClick={() => void submit()}
              disabled={busy || lines.length === 0}
              className="min-h-12 w-full"
            >
              {busy ? "در حال ثبت…" : "ثبت فاکتور"}
            </Button>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={strong ? "font-bold text-stone-950" : "text-stone-800"}>{value}</dd>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] sm:p-5">
      <h2 className="font-semibold text-stone-950">{title}</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/**
 * Phase 27 Wave 4 — scan-to-add. A handheld scanner types the code and presses
 * Enter; this resolves it to exactly one sellable thing and appends the line
 * (or, for a watch, which has no catalogue price, surfaces the unit so the
 * one remaining input — the agreed price — is entered by hand). Ambiguity is
 * surfaced, never silently guessed.
 */
function BarcodeScanField({
  industry,
  variants,
  weightItems,
  prices,
  units,
  onAdd,
}: {
  industry: Industry;
  variants: Variant[];
  weightItems: WeightItem[];
  prices: GoldPrice[];
  units: SerialUnit[];
  onAdd: (line: CartLine) => void;
}) {
  const [code, setCode] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState("");

  async function resolve(rawCode: string) {
    const needle = rawCode.trim();
    if (!needle) return;
    setScanBusy(true);
    setScanError("");
    const { ok, data } = await api<{
      matches?: { itemId: string; serialId?: string | null; itemName: string; kind: string; tracking: string }[];
      message?: string;
    }>(`/api/barcodes/lookup?code=${encodeURIComponent(needle)}`);
    setScanBusy(false);
    setCode("");
    if (!ok) {
      setScanError(data.message ?? "بارکد خوانده نشد.");
      return;
    }
    const matches = data.matches ?? [];
    if (matches.length === 0) {
      setScanError("بارکدی با این کد یافت نشد.");
      return;
    }
    if (matches.length > 1) {
      setScanError("این بارکد به بیش از یک کالا اشاره دارد؛ کالا را دستی انتخاب کنید.");
      return;
    }
    const match = matches[0];

    if (variantApiFor(industry)) {
      const variant = variants.find((v) => v.id === match.itemId);
      if (!variant || !variant.unitPrice) {
        setScanError("این کالا قیمت یا موجودی ندارد؛ از فرم کالا استفاده کنید.");
        return;
      }
      try {
        const breakdown =
          industry === "cosmetics"
            ? computeCosmeticSalePrice({ unitPrice: variant.unitPrice, quantity: "1", discount: 0, vatPercent: 9 })
            : computeAccessorySalePrice({ unitPrice: variant.unitPrice, quantity: "1", discount: 0, vatPercent: 9 });
        onAdd({
          key: newKey(),
          label: variant.name,
          payload: {
            kind: industry === "cosmetics" ? "cosmetic" : isTradeGoodsIndustry(industry) ? "stocked" : "accessory",
            itemId: variant.id,
            quantity: "1",
            discount: 0,
            vatPercent: 9,
          },
          net: Number(breakdown.net),
          vat: Number(breakdown.vat),
          total: Number(breakdown.total),
        });
        return;
      } catch (err) {
        setScanError(err instanceof Error ? err.message : "افزودن کالا ناموفق بود.");
        return;
      }
    }

    if (industry === "jewelry") {
      const item = weightItems.find((i) => i.id === match.itemId);
      const rate = item
        ? prices.filter((p) => p.purity === item.purity).sort((a, b) => b.priceDate.localeCompare(a.priceDate))[0]
        : null;
      if (!item || !rate) {
        setScanError("نرخ روز برای این قطعه ثبت نشده است؛ از فرم کالا استفاده کنید.");
        return;
      }
      try {
        // The same defaults the gold form seeds (7% اجرت، 7% سود، 9% مالیات) —
        // the cashier still sees the breakdown in the cart before settling.
        const breakdown = computeGoldSalePrice({
          netWeight: item.netWeight,
          pricePerGram: rate.pricePerGram,
          makingCharge: { type: "percent", value: 7 },
          profitPercent: 7,
          vatPercent: 9,
        });
        const metalValue = Number(breakdown.metalValue);
        const makingCharge = Number(breakdown.makingCharge);
        const profit = Number(breakdown.profit);
        onAdd({
          key: newKey(),
          label: `${item.name} (${formatQuantity(item.netWeight)} گرم، ${PURITY_LABELS[item.purity]})`,
          payload: {
            kind: "gold",
            itemId: item.id,
            makingChargeType: "percent",
            makingChargeValue: 7,
            profitPercent: 7,
            vatPercent: 9,
          },
          net: metalValue + makingCharge + profit,
          vat: Number(breakdown.vat),
          total: Number(breakdown.total),
          parts: { metalValue, makingCharge, profit },
        });
        return;
      } catch (err) {
        setScanError(err instanceof Error ? err.message : "افزودن کالا ناموفق بود.");
        return;
      }
    }

    if (industry === "watch") {
      const serial = match.serialId
        ? units.find((u) => u.id === match.serialId)
        : units.filter((u) => u.itemId === match.itemId && u.status === "in_stock")[0];
      if (!serial) {
        setScanError("دستگاه با این بارکد موجود نیست.");
        return;
      }
      // A watch has no catalogue price — it is agreed per sale — so the scan
      // names the unit and the cashier enters the one figure the scan cannot.
      setScanError(`دستگاه «${serial.itemName} — ${serial.serialNumber}» شناسایی شد؛ قیمت را در فرم دستگاه وارد کنید.`);
      return;
    }
  }

  return (
    <Panel title="بارکدخوان" hint="بارکد را با بارکدخوان دستی یا دوربین موبایل اسکن کنید؛ کالا بدون لمس کیبورد به فاکتور اضافه می‌شود.">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
        <input
          className={inputClass}
          dir="ltr"
          value={code}
          disabled={scanBusy}
          autoFocus
          placeholder="اسکن بارکد…"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void resolve(code);
          }}
        />
        <CameraScanTrigger
          label="دوربین"
          disabled={scanBusy}
          className="min-h-11 shrink-0 gap-1.5 sm:min-w-28"
          title="اسکن بارکد فروش"
          description="بارکد یا QR کالا را با دوربین بخوانید تا به فاکتور اضافه شود."
          onScan={(scanned) => void resolve(scanned)}
        />
      </div>
      {scanBusy ? <p className="mt-2 text-xs text-muted-foreground">در حال جستجو…</p> : null}
      {scanError ? <p className="mt-2 text-xs leading-5 text-rose-700">{scanError}</p> : null}
    </Panel>
  );
}

/**
 * A gold line: pick a piece, and the price is its net weight × today's rate for
 * its purity, plus اجرت, plus سود, plus VAT — `computeGoldSalePrice`, the same
 * pure function the server will run. Showing it before submitting is the point:
 * the cashier and the customer agree the اجرت before the sale is posted.
 */
function GoldLineForm({
  items,
  prices,
  onAdd,
}: {
  items: WeightItem[];
  prices: GoldPrice[];
  onAdd: (line: CartLine) => void;
}) {
  const money = useMoney();
  const [itemId, setItemId] = useState("");
  const [makingChargeType, setMakingChargeType] = useState<MakingChargeType>("percent");
  const [makingChargeValue, setMakingChargeValue] = useState("7");
  const [profitPercent, setProfitPercent] = useState("7");
  const [vatPercent, setVatPercent] = useState("9");
  const [search, setSearch] = useState("");

  const inStock = useMemo(() => items.filter((i) => i.status === "in_stock"), [items]);
  const deferredSearch = useDeferredValue(search);

  // ⚡ Bolt: Extract expensive string normalization out of the hot filter loop
  // that runs on every keystroke.
  const normalizedInStock = useMemo(() => {
    return inStock.map((i) => ({
      item: i,
      normalizedStr: normalizePosSearchText(`${i.name} ${i.sku ?? ""}`),
    }));
  }, [inStock]);

  const filtered = useMemo(() => {
    const needle = normalizePosSearchText(deferredSearch);
    if (!needle) return inStock;
    return normalizedInStock
      .filter((ni) => ni.normalizedStr.includes(needle))
      .map((ni) => ni.item);
  }, [inStock, normalizedInStock, deferredSearch]);

  const item = inStock.find((i) => i.id === itemId) ?? null;
  // The rate the server will use: the most recent one recorded for this purity.
  const rate = item
    ? prices.filter((p) => p.purity === item.purity).sort((a, b) => b.priceDate.localeCompare(a.priceDate))[0]
    : null;

  let preview: { net: number; vat: number; total: number; parts: CartLine["parts"] } | null = null;
  let previewError: string | null = null;
  if (item && rate) {
    try {
      const breakdown = computeGoldSalePrice({
        netWeight: item.netWeight,
        pricePerGram: rate.pricePerGram,
        makingCharge: {
          type: makingChargeType,
          value:
            makingChargeType === "fixed"
              ? money.fromInput(Math.max(0, Math.round(Number(makingChargeValue))))
              : Number(makingChargeValue),
        },
        profitPercent: Number(profitPercent),
        vatPercent: Number(vatPercent),
      });
      const metalValue = Number(breakdown.metalValue);
      const makingCharge = Number(breakdown.makingCharge);
      const profit = Number(breakdown.profit);
      preview = {
        net: metalValue + makingCharge + profit,
        vat: Number(breakdown.vat),
        total: Number(breakdown.total),
        parts: { metalValue, makingCharge, profit },
      };
    } catch (err) {
      previewError = err instanceof Error ? err.message : "محاسبهٔ قیمت ممکن نیست.";
    }
  }

  return (
    <Panel
      title="افزودن کالای طلا"
      hint="قیمت از وزن خالص و نرخ روزِ عیار همان قطعه محاسبه می‌شود؛ اجرت و سود را اینجا تعیین کنید."
    >
      <Field label="جستجوی کالا">
        <input
          className={inputClass}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="نام یا کد کالا"
        />
      </Field>
      <Field label="کالا">
        <SearchableSelect
          value={itemId}
          onChange={setItemId}
          ariaLabel="انتخاب کالای طلا"
          options={[
            { value: "", label: "انتخاب کنید" },
            ...filtered.map((i) => ({
              value: i.id,
              label: `${i.name} — ${formatQuantity(i.netWeight)} گرم — ${PURITY_LABELS[i.purity]}`,
            })),
          ]}
        />
      </Field>

      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="نوع اجرت">
          <select
            className={inputClass}
            value={makingChargeType}
            onChange={(e) => setMakingChargeType(e.target.value as MakingChargeType)}
          >
            <option value="percent">درصدی</option>
            <option value="fixed">مبلغ ثابت ({money.unitLabel})</option>
          </select>
        </Field>
        <Field label="مقدار اجرت">
          <PersianNumberInput inputMode={makingChargeType === "percent" ? "decimal" : "numeric"}
            className={inputClass}
            dir="ltr"
            value={makingChargeValue}
            onChange={(e) => setMakingChargeValue(e.target.value)}
          />
        </Field>
        <Field label="درصد سود">
          <PersianNumberInput inputMode="decimal"
            className={inputClass}
            dir="ltr"
            value={profitPercent}
            onChange={(e) => setProfitPercent(e.target.value)}
          />
        </Field>
        <Field label="درصد مالیات">
          <PersianNumberInput inputMode="decimal"
            className={inputClass}
            dir="ltr"
            value={vatPercent}
            onChange={(e) => setVatPercent(e.target.value)}
          />
        </Field>
      </div>

      {item && !rate ? (
        <p className="mb-3 rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          نرخ طلای {PURITY_LABELS[item.purity]} ثبت نشده است؛ ابتدا نرخ روز را در صفحهٔ «طلا و جواهر» وارد کنید.
        </p>
      ) : null}
      {previewError ? (
        <p className="mb-3 text-xs text-rose-700">{previewError}</p>
      ) : null}
      {preview ? (
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          طلا {money.format(preview.parts!.metalValue)} · اجرت {money.format(preview.parts!.makingCharge)} · سود{" "}
          {money.format(preview.parts!.profit)} · مالیات {money.format(preview.vat)} —{" "}
          <b className="text-stone-900">{money.format(preview.total)}</b>
        </p>
      ) : null}

      <Button
        disabled={!item || !preview}
        onClick={() => {
          if (!item || !preview) return;
          onAdd({
            key: newKey(),
            label: `${item.name} (${formatQuantity(item.netWeight)} گرم، ${PURITY_LABELS[item.purity]})`,
            payload: {
              kind: "gold",
              itemId: item.id,
              makingChargeType,
              makingChargeValue:
                makingChargeType === "fixed"
                  ? money.fromInput(Math.max(0, Math.round(Number(makingChargeValue))))
                  : Number(makingChargeValue),
              profitPercent: Number(profitPercent),
              vatPercent: Number(vatPercent),
            },
            net: preview.net,
            vat: preview.vat,
            total: preview.total,
            parts: preview.parts,
          });
          setItemId("");
        }}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن به فاکتور
      </Button>
    </Panel>
  );
}

/** A watch line: one serialised unit at an agreed price. Selling it starts its warranty. */
function WatchLineForm({ units, onAdd }: { units: SerialUnit[]; onAdd: (line: CartLine) => void }) {
  const money = useMoney();
  const [serialId, setSerialId] = useState("");
  const [price, setPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [vatPercent, setVatPercent] = useState("9");

  const inStock = useMemo(() => units.filter((u) => u.status === "in_stock"), [units]);
  const unit = inStock.find((u) => u.id === serialId) ?? null;

  const priceRial = price.trim() ? money.parse(price) : 0;
  const discountRial = discount.trim() ? money.parse(discount) : 0;

  let preview: { net: number; vat: number; total: number } | null = null;
  if (unit && priceRial > 0) {
    try {
      const breakdown = computeWatchSalePrice({
        price: priceRial,
        discount: discountRial,
        vatPercent: Number(vatPercent),
      });
      preview = {
        net: Number(breakdown.net),
        vat: Number(breakdown.vat),
        total: Number(breakdown.total),
      };
    } catch {
      preview = null;
    }
  }

  return (
    <Panel title="افزودن دستگاه" hint="هر دستگاه با شماره سریال خودش فروخته می‌شود و گارانتی از همین لحظه آغاز می‌شود.">
      <Field label="دستگاه">
        <SearchableSelect
          value={serialId}
          onChange={setSerialId}
          ariaLabel="انتخاب دستگاه"
          options={[
            { value: "", label: "انتخاب کنید" },
            ...inStock.map((u) => ({ value: u.id, label: `${u.itemName} — ${u.serialNumber}` })),
          ]}
        />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field label={`قیمت (${money.unitLabel})`}>
          <PersianNumberInput inputMode="numeric" className={inputClass} dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} />
        </Field>
        <Field label={`تخفیف (${money.unitLabel})`}>
          <PersianNumberInput inputMode="numeric" className={inputClass} dir="ltr" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </Field>
        <Field label="درصد مالیات">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} />
        </Field>
      </div>
      {preview ? (
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          خالص {money.format(preview.net)} · مالیات {money.format(preview.vat)} —{" "}
          <b className="text-stone-900">{money.format(preview.total)}</b>
        </p>
      ) : null}
      <Button
        disabled={!unit || !preview}
        onClick={() => {
          if (!unit || !preview) return;
          onAdd({
            key: newKey(),
            label: `${unit.itemName} — ${unit.serialNumber}`,
            payload: {
              kind: "watch",
              serialId: unit.id,
              price: priceRial,
              discount: discountRial,
              vatPercent: Number(vatPercent),
            },
            net: preview.net,
            vat: preview.vat,
            total: preview.total,
          });
          setSerialId("");
          setPrice("");
          setDiscount("");
        }}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن به فاکتور
      </Button>
    </Panel>
  );
}

/**
 * A fungible catalogue line: a quantity of one variant, at its standard price
 * unless overridden. Used by accessories (`kind = "accessory"`) and by the
 * trade-goods industries (`kind = "stocked"`); the payload shape is the same
 * and the server routes it to the trade's own posting rule.
 */
function AccessoryLineForm({
  variants,
  onAdd,
  kind = "accessory",
}: {
  variants: Variant[];
  onAdd: (line: CartLine) => void;
  kind?: "accessory" | "stocked";
}) {
  const money = useMoney();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [vatPercent, setVatPercent] = useState("9");

  const sellable = useMemo(
    () => variants.filter((v) => v.kind !== "variant_parent" && Number(v.quantity) > 0),
    [variants],
  );
  const variant = sellable.find((v) => v.id === itemId) ?? null;

  const effectivePrice = unitPrice.trim() ? money.parse(unitPrice) : (variant?.unitPrice ?? 0);
  const discountRial = discount.trim() ? money.parse(discount) : 0;

  let preview: { net: number; vat: number; total: number } | null = null;
  if (variant && effectivePrice > 0 && quantity.trim()) {
    try {
      const breakdown = computeAccessorySalePrice({
        unitPrice: effectivePrice,
        quantity,
        discount: discountRial,
        vatPercent: Number(vatPercent),
      });
      preview = {
        net: Number(breakdown.net),
        vat: Number(breakdown.vat),
        total: Number(breakdown.total),
      };
    } catch {
      preview = null;
    }
  }

  return (
    <Panel title="افزودن کالا" hint="از هر تنوع به تعداد دلخواه؛ قیمت پیش‌فرض همان قیمت ثبت‌شدهٔ تنوع است.">
      <Field label="کالا">
        <SearchableSelect
          value={itemId}
          onChange={setItemId}
          ariaLabel="انتخاب کالا"
          options={[
            { value: "", label: "انتخاب کنید" },
            ...sellable.map((v) => ({
              value: v.id,
              label: `${v.parentName ? `${v.parentName} — ` : ""}${v.name} (موجودی ${formatQuantity(v.quantity)})`,
            })),
          ]}
        />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="تعداد">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field
          label={`قیمت واحد (${money.unitLabel})`}
          hint={variant?.unitPrice ? `قیمت ثبت‌شده: ${money.format(variant.unitPrice)}` : undefined}
        >
          <PersianNumberInput inputMode="numeric"
            className={inputClass}
            dir="ltr"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            placeholder="خالی = قیمت ثبت‌شده"
          />
        </Field>
        <Field label={`تخفیف (${money.unitLabel})`}>
          <PersianNumberInput inputMode="numeric" className={inputClass} dir="ltr" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </Field>
        <Field label="درصد مالیات">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} />
        </Field>
      </div>
      {preview ? (
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          خالص {money.format(preview.net)} · مالیات {money.format(preview.vat)} —{" "}
          <b className="text-stone-900">{money.format(preview.total)}</b>
        </p>
      ) : null}
      <Button
        disabled={!variant || !preview}
        onClick={() => {
          if (!variant || !preview) return;
          onAdd({
            key: newKey(),
            label: `${variant.name} × ${formatQuantity(quantity)}`,
            payload: {
              kind,
              itemId: variant.id,
              quantity,
              unitPrice: unitPrice.trim() ? effectivePrice : undefined,
              discount: discountRial,
              vatPercent: Number(vatPercent),
            },
            net: preview.net,
            vat: preview.vat,
            total: preview.total,
          });
          setItemId("");
          setQuantity("1");
          setUnitPrice("");
          setDiscount("");
        }}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن به فاکتور
      </Button>
    </Panel>
  );
}

/** A cosmetics line: a quantity of one variant, at its standard price unless overridden — the same shape as an accessories line, posted through the cosmetics sell path. */
function CosmeticsLineForm({ variants, onAdd }: { variants: Variant[]; onAdd: (line: CartLine) => void }) {
  const money = useMoney();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [discount, setDiscount] = useState("");
  const [vatPercent, setVatPercent] = useState("9");

  const sellable = useMemo(
    () =>
      variants.filter(
        (v) => v.kind !== "variant_parent" && Number(v.sellableQuantity ?? v.quantity) > 0,
      ),
    [variants],
  );
  const variant = sellable.find((v) => v.id === itemId) ?? null;

  const effectivePrice = unitPrice.trim() ? money.parse(unitPrice) : (variant?.unitPrice ?? 0);
  const discountRial = discount.trim() ? money.parse(discount) : 0;

  let preview: { net: number; vat: number; total: number } | null = null;
  if (variant && effectivePrice > 0 && quantity.trim()) {
    try {
      const breakdown = computeCosmeticSalePrice({
        unitPrice: effectivePrice,
        quantity,
        discount: discountRial,
        vatPercent: Number(vatPercent),
      });
      preview = {
        net: Number(breakdown.net),
        vat: Number(breakdown.vat),
        total: Number(breakdown.total),
      };
    } catch {
      preview = null;
    }
  }

  return (
    <Panel title="افزودن کالا" hint="از هر تنوع به تعداد دلخواه؛ قیمت پیش‌فرض همان قیمت ثبت‌شدهٔ تنوع است.">
      <Field label="کالا">
        <SearchableSelect
          value={itemId}
          onChange={setItemId}
          ariaLabel="انتخاب کالا"
          options={[
            { value: "", label: "انتخاب کنید" },
            ...sellable.map((v) => ({
              value: v.id,
              label: `${v.parentName ? `${v.parentName} — ` : ""}${v.name} (موجودی ${formatQuantity(v.sellableQuantity ?? v.quantity)})`,
            })),
          ]}
        />
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="تعداد">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        <Field
          label={`قیمت واحد (${money.unitLabel})`}
          hint={variant?.unitPrice ? `قیمت ثبت‌شده: ${money.format(variant.unitPrice)}` : undefined}
        >
          <PersianNumberInput inputMode="numeric"
            className={inputClass}
            dir="ltr"
            value={unitPrice}
            onChange={(e) => setUnitPrice(e.target.value)}
            placeholder="خالی = قیمت ثبت‌شده"
          />
        </Field>
        <Field label={`تخفیف (${money.unitLabel})`}>
          <PersianNumberInput inputMode="numeric" className={inputClass} dir="ltr" value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </Field>
        <Field label="درصد مالیات">
          <PersianNumberInput inputMode="decimal" className={inputClass} dir="ltr" value={vatPercent} onChange={(e) => setVatPercent(e.target.value)} />
        </Field>
      </div>
      {preview ? (
        <p className="mb-3 text-xs leading-6 text-muted-foreground">
          خالص {money.format(preview.net)} · مالیات {money.format(preview.vat)} —{" "}
          <b className="text-stone-900">{money.format(preview.total)}</b>
        </p>
      ) : null}
      <Button
        disabled={!variant || !preview}
        onClick={() => {
          if (!variant || !preview) return;
          onAdd({
            key: newKey(),
            label: `${variant.name} × ${formatQuantity(quantity)}`,
            payload: {
              kind: "cosmetic",
              itemId: variant.id,
              quantity,
              unitPrice: unitPrice.trim() ? effectivePrice : undefined,
              discount: discountRial,
              vatPercent: Number(vatPercent),
            },
            net: preview.net,
            vat: preview.vat,
            total: preview.total,
          });
          setItemId("");
          setQuantity("1");
          setUnitPrice("");
          setDiscount("");
        }}
      >
        <PlusIcon aria-hidden="true" className="size-4" />
        افزودن به فاکتور
      </Button>
    </Panel>
  );
}

/**
 * The sales history a retail business never had. It lives here rather than on
 * `/dashboard/orders`, which is a board of *open* order tickets — a retail
 * invoice is settled the moment it is written and would never appear there.
 */
function RecentInvoices({ invoices, loading }: { invoices: InvoiceSummary[]; loading: boolean }) {
  const money = useMoney();
  return (
    <Panel title="فاکتورهای اخیر" hint="آخرین فاکتورهای ثبت‌شده در این شعبه.">
      {loading ? (
        <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
      ) : invoices.length === 0 ? (
        <p className="rounded-xl border border-dashed border-stone-200 px-3 py-6 text-center text-sm text-muted-foreground">
          هنوز فاکتوری ثبت نشده است.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200/80">
          {invoices.map((invoice) => (
            <li key={invoice.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <div className="min-w-0">
                <span className="font-medium text-stone-950">
                  فاکتور {toPersianDigits(invoice.orderNumber)}
                </span>
                <span className="mr-2 text-xs text-muted-foreground">
                  {invoice.customerName ?? "بدون مشتری"} ·{" "}
                  {formatPersianNumber(invoice.lineCount)} قلم
                </span>
              </div>
              <span className="shrink-0 font-semibold text-stone-900">{money.format(invoice.total)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
