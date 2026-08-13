"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber, formatQuantity } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { api, Field, inputClass } from "../ui";
import { ItemAuditPanel } from "../item-audit-panel";
import {
  PURITY_LABELS,
  WEIGHT_ITEM_STATUS_LABELS,
  type Consignor,
  type GoldPriceRow,
  type ItemStone,
  type Purity,
  type Runner,
  type WeightItem,
} from "./jewelry-manager";

const jewelryInputClass = `${inputClass} min-h-[52px] !border-stone-200 !bg-white shadow-none placeholder:text-stone-400 focus-visible:border-amber-500 focus-visible:ring-amber-400/30`;
const secondaryActionClass =
  "min-h-[44px] border-stone-200 bg-white px-3 text-xs text-stone-700 hover:border-amber-300 hover:bg-amber-50 hover:text-stone-950 focus-visible:border-amber-500 focus-visible:ring-amber-400/30";

const STATUS_BADGE_CLASS: Record<WeightItem["status"], string> = {
  in_stock: "bg-emerald-100 text-emerald-900",
  reserved: "bg-amber-100 text-amber-900",
  sold: "bg-stone-200 text-stone-600",
};

function formatRialPerGram(value: string): string {
  return `${formatPersianNumber(Math.round(Number(value)))} ریال`;
}

export function ItemsSection({
  items,
  prices,
  consignors,
  busy,
  run,
}: {
  items: WeightItem[];
  prices: GoldPriceRow[];
  consignors: Consignor[];
  busy: boolean;
  run: Runner;
}) {
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [purity, setPurity] = useState<Purity>("18");
  const [grossWeight, setGrossWeight] = useState("");
  const [netWeight, setNetWeight] = useState("");
  const [unitCostPerGram, setUnitCostPerGram] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !grossWeight.trim() || !netWeight.trim()) return;
    const ok = await run(() =>
      api("/api/jewelry/items", {
        method: "POST",
        body: JSON.stringify({
          name,
          sku: sku.trim() || null,
          purity,
          grossWeight,
          netWeight,
          unitCostPerGram: unitCostPerGram.trim() || null,
        }),
      }),
    );
    if (ok) {
      setName("");
      setSku("");
      setGrossWeight("");
      setNetWeight("");
      setUnitCostPerGram("");
    }
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section
        aria-labelledby="jewelry-items-heading"
        className="order-2 min-w-0 overflow-hidden rounded-2xl bg-card md:order-1"
      >
        <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <h2 id="jewelry-items-heading" className="font-semibold text-stone-950">
            کالاهای وزنی طلا
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            هر قطعه طلا با وزن و عیار خودش؛ بهای تمام‌شده هر گرم را برای محاسبهٔ بهای تمام‌شدهٔ فروش ثبت کنید.
          </p>
        </div>

        <ul className="divide-y divide-stone-200/80">
          {items.map((item) => (
            <ItemRow key={item.id} item={item} consignors={consignors} busy={busy} run={run} />
          ))}
          {items.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">کالایی ثبت نشده است.</li>
          ) : null}
        </ul>
      </section>

      <aside className="order-1 min-w-0 md:order-2">
        <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-[0_1px_2px_rgb(41_37_36/0.035)] md:sticky md:top-4 sm:p-5">
          <h2 className="font-semibold text-stone-950">افزودن کالا</h2>

          <form onSubmit={add} className="mt-4">
            <Field label="نام کالا">
              <input
                className={jewelryInputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="مثلاً دستبند طرح بافت"
                required
              />
            </Field>
            <Field label="کد کالا">
              <input
                className={jewelryInputClass}
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="عیار">
              <SearchableSelect
                className={jewelryInputClass}
                value={purity}
                onChange={(value) => setPurity(value as Purity)}
                options={(Object.keys(PURITY_LABELS) as Purity[]).map((p) => ({
                  value: p,
                  label: PURITY_LABELS[p],
                }))}
              />
            </Field>
            <Field label="وزن ناخالص (گرم)">
              <input
                className={jewelryInputClass}
                dir="ltr"
                inputMode="decimal"
                value={grossWeight}
                onChange={(e) => setGrossWeight(e.target.value)}
                required
              />
            </Field>
            <Field label="وزن خالص (گرم)">
              <input
                className={jewelryInputClass}
                dir="ltr"
                inputMode="decimal"
                value={netWeight}
                onChange={(e) => setNetWeight(e.target.value)}
                required
              />
            </Field>
            <Field label="بهای تمام‌شده هر گرم (ریال)" hint="اگر هنوز مشخص نیست، خالی بگذارید.">
              <input
                className={jewelryInputClass}
                dir="ltr"
                inputMode="decimal"
                value={unitCostPerGram}
                onChange={(e) => setUnitCostPerGram(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30"
            >
              افزودن
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}

type Panel = "cost" | "stones" | "consign" | "sell" | "audit";

function ItemRow({
  item,
  consignors,
  busy,
  run,
}: {
  item: WeightItem;
  consignors: Consignor[];
  busy: boolean;
  run: Runner;
}) {
  const [openPanel, setOpenPanel] = useState<Panel | null>(null);
  const toggle = (panel: Panel) => setOpenPanel((current) => (current === panel ? null : panel));

  return (
    <li className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:px-5">
      <div className="flex min-w-0 flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="min-w-0 break-words font-semibold text-stone-950">{item.name}</h3>
            {item.sku ? <span className="text-xs text-muted-foreground">({item.sku})</span> : null}
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASS[item.status]}`}>
              {WEIGHT_ITEM_STATUS_LABELS[item.status]}
            </span>
            {item.consignorName ? (
              <span className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-900">
                امانی: {item.consignorName}
              </span>
            ) : null}
          </div>

          <dl className="mt-3 grid min-w-0 gap-x-5 gap-y-2 text-xs text-stone-600 sm:grid-cols-2 xl:grid-cols-4">
            <MetaItem label="عیار">{PURITY_LABELS[item.purity]}</MetaItem>
            <MetaItem label="وزن خالص / ناخالص">
              {formatQuantity(item.netWeight)} / {formatQuantity(item.grossWeight)} گرم
            </MetaItem>
            <MetaItem label="بهای هر گرم">
              {item.unitCostPerGram ? formatRialPerGram(item.unitCostPerGram) : "تعیین نشده"}
            </MetaItem>
            {item.stoneCost > 0 ? <MetaItem label="بهای سنگ‌ها">{formatToman(item.stoneCost)}</MetaItem> : null}
          </dl>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-2 sm:flex sm:flex-wrap lg:justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy || item.status === "sold"}
            onClick={() => toggle("cost")}
          >
            ویرایش بها
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy}
            onClick={() => toggle("stones")}
          >
            سنگ‌ها
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryActionClass}
            disabled={busy}
            onClick={() => toggle("audit")}
          >
            تاریخچه
          </Button>
          {!item.consignorId ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryActionClass}
              disabled={busy || item.status === "sold"}
              onClick={() => toggle("consign")}
            >
              امانی کردن
            </Button>
          ) : null}
          {item.status === "in_stock" ? (
            <Button
              type="button"
              size="sm"
              className="min-h-[44px] border border-amber-300 px-3 text-xs font-semibold focus-visible:ring-amber-400/30"
              disabled={busy}
              onClick={() => toggle("sell")}
            >
              فروش
            </Button>
          ) : null}
        </div>
      </div>

      {openPanel === "cost" ? (
        <CostPanel item={item} busy={busy} run={run} onDone={() => setOpenPanel(null)} />
      ) : null}
      {openPanel === "stones" ? <StonesPanel item={item} busy={busy} run={run} /> : null}
      {openPanel === "consign" ? (
        <ConsignPanel item={item} consignors={consignors} busy={busy} run={run} onDone={() => setOpenPanel(null)} />
      ) : null}
      {openPanel === "sell" ? (
        <SellPanel item={item} busy={busy} run={run} onDone={() => setOpenPanel(null)} />
      ) : null}
      {openPanel === "audit" ? <ItemAuditPanel itemId={item.id} /> : null}
    </li>
  );
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="mt-0.5 break-words font-medium text-stone-700">{children}</dd>
    </div>
  );
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl bg-amber-50/60 p-3 sm:p-4">{children}</div>;
}

function CostPanel({
  item,
  busy,
  run,
  onDone,
}: {
  item: WeightItem;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [grossWeight, setGrossWeight] = useState(item.grossWeight);
  const [netWeight, setNetWeight] = useState(item.netWeight);
  const [unitCostPerGram, setUnitCostPerGram] = useState(item.unitCostPerGram ?? "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      api(`/api/jewelry/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          grossWeight,
          netWeight,
          unitCostPerGram: unitCostPerGram.trim() || null,
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <PanelShell>
      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Field label="وزن ناخالص (گرم)">
          <input
            className={jewelryInputClass}
            dir="ltr"
            inputMode="decimal"
            value={grossWeight}
            onChange={(e) => setGrossWeight(e.target.value)}
            required
          />
        </Field>
        <Field label="وزن خالص (گرم)">
          <input
            className={jewelryInputClass}
            dir="ltr"
            inputMode="decimal"
            value={netWeight}
            onChange={(e) => setNetWeight(e.target.value)}
            required
          />
        </Field>
        <Field label="بهای هر گرم (ریال)">
          <input
            className={jewelryInputClass}
            dir="ltr"
            inputMode="decimal"
            value={unitCostPerGram}
            onChange={(e) => setUnitCostPerGram(e.target.value)}
            placeholder="اختیاری"
          />
        </Field>
        <div className="sm:col-span-3">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 px-5 font-semibold">
            ذخیره
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}

function StonesPanel({ item, busy, run }: { item: WeightItem; busy: boolean; run: Runner }) {
  const [stones, setStones] = useState<ItemStone[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [stoneType, setStoneType] = useState("");
  const [carat, setCarat] = useState("");
  const [cost, setCost] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api<{ stones: ItemStone[] }>(`/api/jewelry/items/${item.id}`).then(({ ok, data }) => {
      setLoading(false);
      if (ok) setStones(data.stones);
    });
  }, [item.id]);
  useEffect(load, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!stoneType.trim() || !carat.trim() || !cost.trim()) return;
    const ok = await run(() =>
      api(`/api/jewelry/items/${item.id}/stones`, {
        method: "POST",
        body: JSON.stringify({ stoneType, carat, cost: Number(cost) }),
      }),
    );
    if (ok) {
      setStoneType("");
      setCarat("");
      setCost("");
      load();
    }
  }

  async function remove(stoneId: string) {
    const ok = await run(() => api(`/api/jewelry/items/${item.id}/stones/${stoneId}`, { method: "DELETE" }));
    if (ok) load();
  }

  return (
    <PanelShell>
      {loading ? (
        <p className="text-xs text-muted-foreground">در حال بارگذاری…</p>
      ) : (
        <ul className="mb-3 space-y-2">
          {(stones ?? []).map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 text-xs">
              <span>
                {s.stoneType} · {formatQuantity(s.carat)} قیراط · {formatToman(s.cost)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || item.status === "sold"}
                className="min-h-[36px] border-destructive/25 bg-white px-2 text-destructive hover:border-destructive/40 hover:bg-destructive/5"
                onClick={() => remove(s.id)}
              >
                حذف
              </Button>
            </li>
          ))}
          {stones && stones.length === 0 ? (
            <li className="text-xs text-muted-foreground">سنگی ثبت نشده است.</li>
          ) : null}
        </ul>
      )}

      {item.status !== "sold" ? (
        <form onSubmit={add} className="grid min-w-0 gap-3 sm:grid-cols-4">
          <Field label="نوع سنگ">
            <input className={jewelryInputClass} value={stoneType} onChange={(e) => setStoneType(e.target.value)} />
          </Field>
          <Field label="وزن (قیراط)">
            <input
              className={jewelryInputClass}
              dir="ltr"
              inputMode="decimal"
              value={carat}
              onChange={(e) => setCarat(e.target.value)}
            />
          </Field>
          <Field label="بها (ریال)">
            <input
              className={jewelryInputClass}
              dir="ltr"
              inputMode="numeric"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] w-full border border-amber-300 px-3 font-semibold">
              افزودن سنگ
            </Button>
          </div>
        </form>
      ) : null}
    </PanelShell>
  );
}

function ConsignPanel({
  item,
  consignors,
  busy,
  run,
  onDone,
}: {
  item: WeightItem;
  consignors: Consignor[];
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [consignorId, setConsignorId] = useState(consignors[0]?.id ?? "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!consignorId) return;
    const ok = await run(() =>
      api(`/api/jewelry/items/${item.id}/consign`, {
        method: "POST",
        body: JSON.stringify({ consignorId }),
      }),
    );
    if (ok) onDone();
  }

  if (consignors.length === 0) {
    return (
      <PanelShell>
        <p className="text-xs text-muted-foreground">
          ابتدا از تب «امانت‌گذاران» یک امانت‌گذار ثبت کنید.
        </p>
      </PanelShell>
    );
  }

  return (
    <PanelShell>
      <form onSubmit={submit} className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field label="امانت‌گذار">
          <SearchableSelect
            className={jewelryInputClass}
            value={consignorId}
            onChange={setConsignorId}
            options={consignors.map((c) => ({ value: c.id, label: c.name }))}
          />
        </Field>
        <div className="flex items-end">
          <Button type="submit" disabled={busy} size="sm" className="min-h-[44px] border border-amber-300 px-5 font-semibold">
            ثبت به‌عنوان امانی
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}

const PAYMENT_METHOD_LABELS = { cash: "نقدی", bank: "کارت‌خوان / بانک", credit: "نسیه" } as const;

function SellPanel({
  item,
  busy,
  run,
  onDone,
}: {
  item: WeightItem;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [makingChargeType, setMakingChargeType] = useState<"percent" | "fixed">("percent");
  const [makingChargeValue, setMakingChargeValue] = useState("7");
  const [profitPercent, setProfitPercent] = useState("10");
  const [vatPercent, setVatPercent] = useState("9");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "bank" | "credit">("cash");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() =>
      api(`/api/jewelry/items/${item.id}/sell`, {
        method: "POST",
        body: JSON.stringify({
          makingChargeType,
          makingChargeValue: Number(makingChargeValue),
          profitPercent: Number(profitPercent),
          vatPercent: Number(vatPercent),
          paymentMethod,
        }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <PanelShell>
      <form onSubmit={submit} className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="نوع اجرت">
          <SearchableSelect
            className={jewelryInputClass}
            value={makingChargeType}
            onChange={(value) => setMakingChargeType(value as "percent" | "fixed")}
            options={[
              { value: "percent", label: "درصدی از ارزش فلز" },
              { value: "fixed", label: "مبلغ ثابت (ریال)" },
            ]}
          />
        </Field>
        <Field label={makingChargeType === "percent" ? "درصد اجرت" : "مبلغ اجرت (ریال)"}>
          <input
            className={jewelryInputClass}
            dir="ltr"
            inputMode="decimal"
            value={makingChargeValue}
            onChange={(e) => setMakingChargeValue(e.target.value)}
          />
        </Field>
        <Field label="درصد سود">
          <input
            className={jewelryInputClass}
            dir="ltr"
            inputMode="decimal"
            value={profitPercent}
            onChange={(e) => setProfitPercent(e.target.value)}
          />
        </Field>
        <Field label="درصد مالیات">
          <input
            className={jewelryInputClass}
            dir="ltr"
            inputMode="decimal"
            value={vatPercent}
            onChange={(e) => setVatPercent(e.target.value)}
          />
        </Field>
        <Field label="روش پرداخت">
          <SearchableSelect
            className={jewelryInputClass}
            value={paymentMethod}
            onChange={(value) => setPaymentMethod(value as "cash" | "bank" | "credit")}
            options={Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </Field>
        <div className="sm:col-span-2 lg:col-span-5">
          <Button
            type="submit"
            disabled={busy}
            size="sm"
            className="min-h-[44px] border border-amber-300 px-6 font-semibold"
          >
            ثبت فروش
          </Button>
        </div>
      </form>
    </PanelShell>
  );
}
