"use client";

/**
 * Phase 42 — «افزودن محصول»: the reference's tabbed form (قیمت‌گذاری، عمومی،
 * سفارش، مالیات، ویژگی محصول) wearing the platform chrome, with the draft
 * list the reference seats beside it — drafts live in this device's storage
 * until saved. Variant rows map onto `item_variant_attributes` through the
 * attribute master, and «ایجاد خودکار بارکد» mints a valid EAN-13 from the
 * shop's first weight-barcode prefix (weight-barcode.ts).
 */
import { useEffect, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { generateItemBarcode } from "@/lib/weight-barcode";
import type { AttributeDefinition } from "@/lib/product-attributes-service";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { cardClass, EmptyState, SectionCardSkeleton, TabBar, TabPanel } from "../page-chrome";

const DRAFTS_KEY = "products-add-drafts";

interface VariantDraft {
  id: number;
  values: Record<string, string>;
  sku: string;
}

interface FormState {
  name: string;
  barcode: string;
  autoBarcode: boolean;
  sku: string;
  autoSku: boolean;
  notSellable: boolean;
  sellPrice: string;
  purchasePrice: string;
  unit: string;
  subUnit: string;
  conversionFactor: string;
  reorderReminder: string;
  minOrder: string;
  leadTimeDays: string;
  storageLocation: string;
  taxSalePercent: string;
  taxPurchasePercent: string;
  variants: VariantDraft[];
}

const EMPTY_FORM: FormState = {
  name: "",
  barcode: "",
  autoBarcode: false,
  sku: "",
  autoSku: false,
  notSellable: false,
  sellPrice: "",
  purchasePrice: "",
  unit: "",
  subUnit: "",
  conversionFactor: "",
  reorderReminder: "",
  minOrder: "",
  leadTimeDays: "",
  storageLocation: "",
  taxSalePercent: "",
  taxPurchasePercent: "",
  variants: [],
};

interface StoredDraft {
  id: number;
  savedAt: number;
  form: FormState;
}

function readDrafts(): StoredDraft[] {
  try {
    const raw = window.localStorage.getItem(DRAFTS_KEY);
    return raw ? (JSON.parse(raw) as StoredDraft[]) : [];
  } catch {
    return [];
  }
}

const TABS = [
  { key: "pricing", label: "قیمت‌گذاری" },
  { key: "general", label: "عمومی" },
  { key: "order", label: "سفارش" },
  { key: "tax", label: "مالیات" },
  { key: "attributes", label: "ویژگی محصول" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function ProductAddSection({ apiBase }: { apiBase: string }) {
  const money = useMoney();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [tab, setTab] = useState<TabKey>("pricing");
  const [definitions, setDefinitions] = useState<AttributeDefinition[]>([]);
  const [templates, setTemplates] = useState<{ prefix: string }[]>([]);
  const [drafts, setDrafts] = useState<StoredDraft[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => setDrafts(readDrafts()), []);
  useEffect(() => {
    Promise.all([
      api<{ definitions: AttributeDefinition[] }>("/api/products/attributes"),
      api<{ templates: { prefix: string }[] }>("/api/products/barcode-templates"),
    ]).then(([attributesRes, templatesRes]) => {
      if (attributesRes.ok) setDefinitions(attributesRes.data.definitions.filter((d) => d.isActive));
      if (templatesRes.ok) setTemplates(templatesRes.data.templates);
      setReady(true);
    });
  }, []);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    if (form.autoBarcode && !form.barcode) {
      set("barcode", generateItemBarcode(templates[0]?.prefix ?? "20"));
    }
  }, [form.autoBarcode, form.barcode, templates]);

  useEffect(() => {
    if (form.autoSku && !form.sku) {
      set("sku", String(Date.now()).slice(-6));
    }
  }, [form.autoSku, form.sku]);

  function persistDrafts(next: StoredDraft[]) {
    setDrafts(next);
    try {
      window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(next));
    } catch {
      // Private browsing: drafts live for the session only.
    }
  }

  function stashDraft() {
    const snapshot = { id: Date.now(), savedAt: Date.now(), form };
    persistDrafts([snapshot, ...drafts].slice(0, 10));
    setForm(EMPTY_FORM);
    setNotice("پیش‌نویس ذخیره شد.");
  }

  function openDraft(draft: StoredDraft) {
    setForm({ ...EMPTY_FORM, ...draft.form });
    persistDrafts(drafts.filter((d) => d.id !== draft.id));
  }

  function addVariantRow() {
    setForm((current) => ({
      ...current,
      variants: [...current.variants, { id: Date.now(), values: {}, sku: "" }],
    }));
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("نام کالا الزامی است.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    const num = (value: string) => (value.trim() === "" ? null : Number(value));
    const { ok, data } = await api("/api/products/items", {
      method: "POST",
      body: JSON.stringify({
        name: form.name.trim(),
        sku: form.sku.trim() || null,
        barcode: form.barcode.trim() || null,
        isSellable: !form.notSellable,
        unit: form.unit.trim() || null,
        subUnit: form.subUnit.trim() || null,
        conversionFactor: num(form.conversionFactor),
        minOrderQty: num(form.minOrder),
        reorderReminderQty: num(form.reorderReminder),
        leadTimeDays: num(form.leadTimeDays),
        storageLocation: form.storageLocation.trim() || null,
        taxSalePercent: num(form.taxSalePercent),
        taxPurchasePercent: num(form.taxPurchasePercent),
        sellPrice:
          form.sellPrice.trim() === ""
            ? null
            : money.fromInput(Math.max(0, Math.round(Number(form.sellPrice)))),
        purchasePrice:
          form.purchasePrice.trim() === ""
            ? null
            : money.fromInput(Math.max(0, Math.round(Number(form.purchasePrice)))),
        variants: form.variants.map((variant) => ({
          sku: variant.sku.trim() || null,
          attributes: Object.entries(variant.values)
            .filter(([, value]) => value.trim())
            .map(([name, value]) => ({ name, value: value.trim() })),
        })),
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(
        data.error === "missing_fields"
          ? "نام کالا الزامی است."
          : data.error === "invalid_attributes"
            ? String(data.message ?? "ویژگی‌های تنوع معتبر نیست.")
            : "ذخیره نشد؛ دوباره تلاش کنید.",
      );
      return;
    }
    setForm(EMPTY_FORM);
    setNotice("محصول ذخیره شد.");
  }

  if (!ready) {
    return (
      <div className="min-w-0 space-y-4">
        <SectionCardSkeleton rows={6} />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5">
      <form id="product-add-form" onSubmit={save} className="min-w-0 space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <section className={`${cardClass} p-4 sm:p-5`}>
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="نام کالا *">
                <input
                  className={inputClass}
                  value={form.name}
                  onChange={(event) => set("name", event.target.value)}
                  required
                />
              </Field>
            </div>
            <Field label="بارکد">
              <input
                className={inputClass}
                dir="ltr"
                value={form.barcode}
                onChange={(event) => set("barcode", event.target.value)}
                disabled={form.autoBarcode}
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={form.autoBarcode}
                  onChange={(event) => {
                    set("autoBarcode", event.target.checked);
                    if (event.target.checked) set("barcode", generateItemBarcode(templates[0]?.prefix ?? "20"));
                    else set("barcode", "");
                  }}
                  className="size-4 accent-amber-600"
                />
                ایجاد خودکار بارکد EAN۱۳
              </label>
            </Field>
            <Field label="کد کالا">
              <input
                className={inputClass}
                dir="ltr"
                value={form.sku}
                onChange={(event) => set("sku", event.target.value)}
                disabled={form.autoSku}
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={form.autoSku}
                  onChange={(event) => {
                    set("autoSku", event.target.checked);
                    if (event.target.checked) set("sku", String(Date.now()).slice(-6));
                    else set("sku", "");
                  }}
                  className="size-4 accent-amber-600"
                />
                ایجاد خودکار کد کالا
              </label>
            </Field>
            <label className="flex items-center gap-2 text-sm text-foreground sm:col-span-2">
              <input
                type="checkbox"
                checked={form.notSellable}
                onChange={(event) => set("notSellable", event.target.checked)}
                className="size-4 accent-amber-600"
              />
              غیر قابل فروش
            </label>
          </div>
        </section>

        <TabBar idPrefix="product-add" label="بخش‌های فرم محصول" tabs={TABS} active={tab} onChange={setTab} />
        <TabPanel idPrefix="product-add" active={tab}>
          <section className={`${cardClass} p-4 sm:p-5`}>
            {tab === "pricing" ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Field label={`قیمت فروش (${money.unitLabel})`}>
                  <PersianNumberInput value={form.sellPrice} onChange={(event) => set("sellPrice", event.target.value)} />
                </Field>
                <Field label={`قیمت خرید (${money.unitLabel})`}>
                  <PersianNumberInput value={form.purchasePrice} onChange={(event) => set("purchasePrice", event.target.value)} />
                </Field>
              </div>
            ) : null}
            {tab === "general" ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-3">
                <Field label="واحد اصلی">
                  <input className={inputClass} value={form.unit} onChange={(event) => set("unit", event.target.value)} placeholder="عدد" />
                </Field>
                <Field label="واحد فرعی">
                  <input className={inputClass} value={form.subUnit} onChange={(event) => set("subUnit", event.target.value)} placeholder="کارتن" />
                </Field>
                <Field label="ضریب تبدیل">
                  <PersianNumberInput value={form.conversionFactor} onChange={(event) => set("conversionFactor", event.target.value)} placeholder="۲۴" />
                </Field>
              </div>
            ) : null}
            {tab === "order" ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Field label="یادآوری سفارش">
                  <PersianNumberInput value={form.reorderReminder} onChange={(event) => set("reorderReminder", event.target.value)} placeholder="۵" />
                </Field>
                <Field label="حداقل سفارش">
                  <PersianNumberInput value={form.minOrder} onChange={(event) => set("minOrder", event.target.value)} placeholder="۱۰" />
                </Field>
                <Field label="زمان تحویل (روز)">
                  <PersianNumberInput value={form.leadTimeDays} onChange={(event) => set("leadTimeDays", event.target.value)} placeholder="۳" />
                </Field>
                <Field label="آدرس کالا">
                  <input className={inputClass} value={form.storageLocation} onChange={(event) => set("storageLocation", event.target.value)} placeholder="راهرو ۱ - قفسه ۲ - طبقه ۳" />
                </Field>
              </div>
            ) : null}
            {tab === "tax" ? (
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <Field label="مالیات فروش (درصد)">
                  <PersianNumberInput value={form.taxSalePercent} onChange={(event) => set("taxSalePercent", event.target.value)} placeholder="۹" />
                </Field>
                <Field label="مالیات خرید (درصد)">
                  <PersianNumberInput value={form.taxPurchasePercent} onChange={(event) => set("taxPurchasePercent", event.target.value)} placeholder="۹" />
                </Field>
              </div>
            ) : null}
            {tab === "attributes" ? (
              <div className="min-w-0 space-y-4">
                {definitions.length === 0 ? (
                  <EmptyState>ویژگی‌ای تعریف نشده؛ ابتدا در «ویژگی محصول» ویژگی بسازید.</EmptyState>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">محصولات با ویژگی (تنوع‌ها)</p>
                    {form.variants.map((variant, index) => (
                      <div key={variant.id} className="rounded-xl border border-border/80 bg-muted/40 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-medium text-muted-foreground">تنوع {toPersianDigits(index + 1)}</p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="size-8 p-0 text-rose-600 dark:text-rose-400"
                            aria-label="حذف تنوع"
                            onClick={() =>
                              setForm((current) => ({
                                ...current,
                                variants: current.variants.filter((v) => v.id !== variant.id),
                              }))
                            }
                          >
                            <Trash2Icon aria-hidden="true" className="size-4" />
                          </Button>
                        </div>
                        <div className="mt-2 grid min-w-0 gap-3 sm:grid-cols-2">
                          {definitions.map((definition) => (
                            <Field key={definition.id} label={definition.name}>
                              {definition.options.length > 0 ? (
                                <SearchableSelect
                                  className={inputClass}
                                  value={variant.values[definition.name] ?? ""}
                                  onChange={(value) =>
                                    setForm((current) => ({
                                      ...current,
                                      variants: current.variants.map((v) =>
                                        v.id === variant.id
                                          ? { ...v, values: { ...v.values, [definition.name]: value } }
                                          : v,
                                      ),
                                    }))
                                  }
                                  options={definition.options.map((option) => ({ value: option, label: option }))}
                                  placeholder="انتخاب"
                                />
                              ) : (
                                <input
                                  className={inputClass}
                                  value={variant.values[definition.name] ?? ""}
                                  onChange={(event) =>
                                    setForm((current) => ({
                                      ...current,
                                      variants: current.variants.map((v) =>
                                        v.id === variant.id
                                          ? { ...v, values: { ...v.values, [definition.name]: event.target.value } }
                                          : v,
                                      ),
                                    }))
                                  }
                                />
                              )}
                            </Field>
                          ))}
                          <Field label="کد کالا (اختیاری)">
                            <input
                              className={inputClass}
                              dir="ltr"
                              value={variant.sku}
                              onChange={(event) =>
                                setForm((current) => ({
                                  ...current,
                                  variants: current.variants.map((v) =>
                                    v.id === variant.id ? { ...v, sku: event.target.value } : v,
                                  ),
                                }))
                              }
                            />
                          </Field>
                        </div>
                      </div>
                    ))}
                    <Button type="button" variant="outline" size="sm" className="min-h-10 w-full border-dashed" onClick={addVariantRow}>
                      <PlusIcon aria-hidden="true" className="size-4" />
                      اضافه کردن آیتم
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </section>
        </TabPanel>
      </form>

      <aside className="min-w-0 space-y-4">
        <section className={`${cardClass} p-4`}>
          <h2 className="font-semibold text-foreground">
            لیست پیش‌نویس ({toPersianDigits(drafts.length)})
          </h2>
          <ul className="mt-3 space-y-2">
            {drafts.map((draft) => (
              <li key={draft.id} className="flex items-center justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2">
                <button type="button" className="min-w-0 text-start" onClick={() => openDraft(draft)}>
                  <span className="block truncate text-sm font-medium text-foreground">
                    {draft.form.name.trim() || "بدون نام"}
                  </span>
                  <span className="block text-xs text-muted-foreground">پیش‌نویس فرم</span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="size-8 shrink-0 p-0 text-rose-600 dark:text-rose-400"
                  aria-label="حذف پیش‌نویس"
                  onClick={() => persistDrafts(drafts.filter((d) => d.id !== draft.id))}
                >
                  <Trash2Icon aria-hidden="true" className="size-4" />
                </Button>
              </li>
            ))}
            {drafts.length === 0 ? (
              <li className="text-xs text-muted-foreground">پیش‌نویسی ثبت نشده است.</li>
            ) : null}
          </ul>
          <Button type="button" variant="outline" size="sm" className="mt-3 min-h-10 w-full border-dashed" onClick={stashDraft}>
            <PlusIcon aria-hidden="true" className="size-4" />
            باز کردن فرم جدید
          </Button>
          <Button type="submit" form="product-add-form" disabled={busy} size="lg" className="mt-2 w-full font-semibold">
            ذخیره محصولات
          </Button>
          {notice ? <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">{notice}</p> : null}
        </section>
      </aside>
    </div>
  );
}
