"use client";

/**
 * «افزودن محصول» — a validated, responsive product-family form.
 *
 * Drafts are isolated by business/branch in this browser. The same pure input
 * parser runs here and in the API, while the server commits the parent,
 * variants, barcodes and opening values atomically.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarcodeIcon,
  CheckCircle2Icon,
  Layers3Icon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMoney } from "@/components/money/money-context";
import { internalBarcodeForPayload } from "@/lib/barcode";
import { accountingProductsHref } from "@/lib/app-routes";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  parseProductCreateInput,
  type ProductFormSection,
  type ProductValidationIssue,
} from "@/lib/product-input";
import type { AttributeDefinition } from "@/lib/product-attributes-service";
import { api, ErrorBox, Field, inputClass } from "../ui";
import {
  cardClass,
  EmptyState,
  SectionCard,
  SectionCardSkeleton,
  TabBar,
  TabPanel,
} from "../page-chrome";

const DRAFTS_KEY_PREFIX = "products-add-drafts:v2";
const MAX_DRAFTS = 10;

type DraftId = string | number;

interface VariantDraft {
  id: DraftId;
  values: Record<string, string>;
  sku: string;
  barcode: string;
  autoBarcode: boolean;
  sellPrice: string;
  purchasePrice: string;
  quantity: string;
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
  quantity: string;
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
  quantity: "",
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
  id: DraftId;
  savedAt: number;
  form: FormState;
}

const TABS = [
  { key: "pricing", label: "قیمت‌گذاری" },
  { key: "general", label: "عمومی" },
  { key: "order", label: "سفارش" },
  { key: "tax", label: "مالیات" },
  { key: "attributes", label: "تنوع‌ها" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const SECTION_TO_TAB: Partial<Record<ProductFormSection, TabKey>> = {
  pricing: "pricing",
  general: "general",
  order: "order",
  tax: "tax",
  attributes: "attributes",
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Tolerate stale/corrupt localStorage instead of crashing the whole page. */
function safeForm(value: unknown): FormState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_FORM };
  const raw = value as Record<string, unknown>;
  const variants = Array.isArray(raw.variants)
    ? raw.variants.slice(0, 100).flatMap((entry, index): VariantDraft[] => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
        const variant = entry as Record<string, unknown>;
        const rawValues =
          variant.values && typeof variant.values === "object" && !Array.isArray(variant.values)
            ? (variant.values as Record<string, unknown>)
            : {};
        const values = Object.fromEntries(
          Object.entries(rawValues)
            .filter(([, option]) => typeof option === "string")
            .map(([name, option]) => [name, String(option)]),
        );
        return [
          {
            id:
              typeof variant.id === "string" || typeof variant.id === "number"
                ? variant.id
                : `restored-${index}`,
            values,
            sku: text(variant.sku),
            barcode: text(variant.barcode),
            autoBarcode: variant.autoBarcode === true,
            sellPrice: text(variant.sellPrice),
            purchasePrice: text(variant.purchasePrice),
            quantity: text(variant.quantity),
          },
        ];
      })
    : [];

  return {
    name: text(raw.name),
    barcode: text(raw.barcode),
    autoBarcode: raw.autoBarcode === true,
    sku: text(raw.sku),
    autoSku: raw.autoSku === true,
    notSellable: raw.notSellable === true,
    sellPrice: text(raw.sellPrice),
    purchasePrice: text(raw.purchasePrice),
    quantity: text(raw.quantity),
    unit: text(raw.unit),
    subUnit: text(raw.subUnit),
    conversionFactor: text(raw.conversionFactor),
    reorderReminder: text(raw.reorderReminder),
    minOrder: text(raw.minOrder),
    leadTimeDays: text(raw.leadTimeDays),
    storageLocation: text(raw.storageLocation),
    taxSalePercent: text(raw.taxSalePercent),
    taxPurchasePercent: text(raw.taxPurchasePercent),
    variants,
  };
}

function readDrafts(storageKey: string): StoredDraft[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_DRAFTS).flatMap((entry): StoredDraft[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const draft = entry as Record<string, unknown>;
      if (
        (typeof draft.id !== "string" && typeof draft.id !== "number") ||
        typeof draft.savedAt !== "number" ||
        !Number.isFinite(draft.savedAt)
      ) {
        return [];
      }
      return [{ id: draft.id, savedAt: draft.savedAt, form: safeForm(draft.form) }];
    });
  } catch {
    return [];
  }
}

function hasContent(form: FormState): boolean {
  return (
    form.notSellable ||
    form.variants.length > 0 ||
    Object.entries(form).some(([key, value]) =>
      key === "variants" || key === "notSellable" || typeof value !== "string" ? false : value.trim() !== "",
    )
  );
}

function uniqueId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function generatedSku(): string {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return `K-${values[0].toString(36).toUpperCase().padStart(7, "0").slice(-7)}`;
  }
  return `K-${Date.now().toString(36).slice(-7).toUpperCase()}`;
}

function generatedBarcode(): string {
  let seed: bigint;
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    seed = (BigInt(values[0]) << 32n) | BigInt(values[1]);
  } else {
    seed = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  }
  const payload = (seed % 100_000_000_000n).toString().padStart(11, "0");
  return internalBarcodeForPayload(payload);
}

function draftDate(savedAt: number): string {
  try {
    return toPersianDigits(formatJalali(new Date(savedAt), { withTime: true }));
  } catch {
    return "زمان نامشخص";
  }
}

function InlineError({ message }: { message?: string }) {
  return message ? <p className="mt-1 text-xs text-destructive">{message}</p> : null;
}

export function ProductAddSection({ draftScope }: { draftScope: string }) {
  const money = useMoney();
  const storageKey = `${DRAFTS_KEY_PREFIX}:${draftScope}`;
  const nameRef = useRef<HTMLInputElement>(null);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [tab, setTab] = useState<TabKey>("pricing");
  const [definitions, setDefinitions] = useState<AttributeDefinition[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [drafts, setDrafts] = useState<StoredDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<DraftId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [issues, setIssues] = useState<ProductValidationIssue[]>([]);

  useEffect(() => {
    setDrafts(readDrafts(storageKey));
    setActiveDraftId(null);
  }, [storageKey]);

  const loadDefinitions = useCallback(() => {
    setLoadError("");
    api<{ definitions: AttributeDefinition[]; error?: string }>("/api/products/attributes").then(
      ({ ok, data }) => {
        if (ok && Array.isArray(data.definitions)) {
          setDefinitions(data.definitions.filter((definition) => definition?.isActive));
        } else {
          setDefinitions([]);
          setLoadError("ویژگی‌های محصول خوانده نشد. برای ساخت تنوع، دوباره تلاش کنید.");
        }
      },
    );
  }, []);
  useEffect(loadDefinitions, [loadDefinitions]);

  const fieldErrors = useMemo(() => {
    const result = new Map<string, string>();
    issues.forEach((entry) => {
      if (!result.has(entry.field)) result.set(entry.field, entry.message);
    });
    return result;
  }, [issues]);

  function clearFeedback() {
    setError("");
    setNotice("");
    setIssues([]);
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    clearFeedback();
    setForm((current) => ({ ...current, [key]: value }));
  };

  function setVariant(variantId: DraftId, patch: Partial<VariantDraft>) {
    clearFeedback();
    setForm((current) => ({
      ...current,
      variants: current.variants.map((variant) =>
        variant.id === variantId ? { ...variant, ...patch } : variant,
      ),
    }));
  }

  function persistDrafts(next: StoredDraft[]) {
    const limited = next.slice(0, MAX_DRAFTS);
    setDrafts(limited);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(limited));
    } catch {
      // Private browsing/storage quota: keep drafts for this mounted session.
    }
  }

  function upsertCurrentDraft(source: StoredDraft[]): { drafts: StoredDraft[]; id: DraftId } {
    const now = Date.now();
    const id = activeDraftId ?? uniqueId("draft");
    const snapshot: StoredDraft = { id, savedAt: now, form };
    return {
      id,
      drafts: [snapshot, ...source.filter((draft) => draft.id !== id)].slice(0, MAX_DRAFTS),
    };
  }

  function resetForm(message?: string) {
    setForm({ ...EMPTY_FORM });
    setActiveDraftId(null);
    setTab("pricing");
    setError("");
    setIssues([]);
    if (message) setNotice(message);
    requestAnimationFrame(() => nameRef.current?.focus());
  }

  function stashDraft() {
    if (!hasContent(form)) {
      setError("فرم خالی است؛ ابتدا بخشی از اطلاعات محصول را وارد کنید.");
      return;
    }
    const result = upsertCurrentDraft(drafts);
    persistDrafts(result.drafts);
    resetForm(activeDraftId === null ? "پیش‌نویس ذخیره شد و فرم تازه آماده است." : "تغییرات پیش‌نویس ذخیره شد.");
  }

  function openDraft(draft: StoredDraft) {
    if (activeDraftId === draft.id) return;
    let next = drafts;
    if (hasContent(form)) next = upsertCurrentDraft(next).drafts;
    // Keep the requested draft even when auto-saving a tenth current draft.
    if (!next.some((entry) => entry.id === draft.id)) next = [draft, ...next].slice(0, MAX_DRAFTS);
    persistDrafts(next);
    setForm(safeForm(draft.form));
    setActiveDraftId(draft.id);
    setError("");
    setNotice(hasContent(form) ? "فرم قبلی خودکار به‌صورت پیش‌نویس ذخیره شد." : "پیش‌نویس برای ویرایش باز شد.");
    setIssues([]);
  }

  function removeDraft(draftId: DraftId) {
    persistDrafts(drafts.filter((draft) => draft.id !== draftId));
    if (activeDraftId === draftId) setActiveDraftId(null);
  }

  function removeVariantRow(variantId: DraftId) {
    const removed = form.variants.find((variant) => variant.id === variantId);
    const finalVariant = form.variants.length === 1 ? removed : undefined;
    clearFeedback();
    setForm((current) => ({
      ...current,
      barcode: finalVariant?.barcode || current.barcode,
      autoBarcode: finalVariant?.barcode ? finalVariant.autoBarcode : current.autoBarcode,
      variants: current.variants.filter((variant) => variant.id !== variantId),
    }));
    if (finalVariant?.barcode) {
      setNotice("بارکد آخرین تنوع به محصول ساده برگردانده شد.");
    }
  }

  function addVariantRow() {
    const firstVariant = form.variants.length === 0;
    const movedBarcode = firstVariant ? form.barcode : "";
    setForm((current) => ({
      ...current,
      barcode: firstVariant ? "" : current.barcode,
      autoBarcode: firstVariant ? false : current.autoBarcode,
      variants: [
        ...current.variants,
        {
          id: uniqueId("variant"),
          values: {},
          sku: "",
          barcode: movedBarcode,
          autoBarcode: firstVariant ? current.autoBarcode : false,
          sellPrice: "",
          purchasePrice: "",
          quantity: "",
        },
      ],
    }));
    clearFeedback();
    if (movedBarcode) setNotice("بارکد محصول به تنوع اول منتقل شد؛ هر تنوع باید بارکد خودش را داشته باشد.");
  }

  function priceToRial(value: string): string | null {
    if (!value.trim()) return null;
    try {
      return money.parseText(value);
    } catch {
      return value;
    }
  }

  function requestPayload() {
    const activeAttributeNames = new Set((definitions ?? []).map((definition) => definition.name));
    return {
      name: form.name,
      sku: form.sku || null,
      barcode: form.barcode || null,
      isSellable: !form.notSellable,
      unit: form.unit || null,
      subUnit: form.subUnit || null,
      conversionFactor: form.conversionFactor || null,
      minOrderQty: form.minOrder || null,
      reorderReminderQty: form.reorderReminder || null,
      leadTimeDays: form.leadTimeDays || null,
      storageLocation: form.storageLocation || null,
      taxSalePercent: form.taxSalePercent || null,
      taxPurchasePercent: form.taxPurchasePercent || null,
      sellPrice: priceToRial(form.sellPrice),
      purchasePrice: priceToRial(form.purchasePrice),
      quantity: form.quantity || null,
      variants: form.variants.map((variant) => ({
        sku: variant.sku || null,
        barcode: variant.barcode || null,
        sellPrice: priceToRial(variant.sellPrice),
        purchasePrice: priceToRial(variant.purchasePrice),
        quantity: variant.quantity || null,
        attributes: Object.entries(variant.values)
          .filter(([name, value]) => activeAttributeNames.has(name) && value.trim())
          .map(([name, value]) => ({ name, value })),
      })),
    };
  }

  function showIssues(nextIssues: ProductValidationIssue[]) {
    setIssues(nextIssues);
    const first = nextIssues[0];
    const remaining = nextIssues.length - 1;
    setError(
      first
        ? `${first.message}${remaining > 0 ? ` (${toPersianDigits(remaining)} مورد دیگر را هم بررسی کنید.)` : ""}`
        : "اطلاعات محصول معتبر نیست.",
    );
    const targetTab = first ? SECTION_TO_TAB[first.section] : undefined;
    if (targetTab) setTab(targetTab);
    if (first?.section === "base") requestAnimationFrame(() => nameRef.current?.focus());
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const parsed = parseProductCreateInput(requestPayload());
    if (!parsed.ok) {
      setNotice("");
      showIssues(parsed.issues);
      return;
    }

    setBusy(true);
    setError("");
    setNotice("");
    setIssues([]);
    const result = await api<{
      error?: string;
      message?: string;
      issues?: ProductValidationIssue[];
    }>("/api/products/items", {
      method: "POST",
      body: JSON.stringify(parsed.data),
    });
    setBusy(false);

    if (!result.ok) {
      if (Array.isArray(result.data.issues) && result.data.issues.length > 0) {
        showIssues(result.data.issues);
      } else if (result.data.error === "duplicate_barcode") {
        setTab(form.variants.length > 0 ? "attributes" : tab);
        setError(result.data.message ?? "این بارکد قبلاً برای محصول دیگری ثبت شده است.");
      } else if (result.data.error === "no_location") {
        setError("برای ثبت محصول باید یک شعبهٔ فعال داشته باشید.");
      } else if (result.data.error === "network_error") {
        setError("ارتباط با سرور برقرار نشد. اطلاعات فرم حفظ شده است؛ دوباره تلاش کنید.");
      } else {
        setError(result.data.message ?? "محصول ذخیره نشد. اطلاعات فرم حفظ شده است؛ دوباره تلاش کنید.");
      }
      return;
    }

    if (activeDraftId !== null) {
      persistDrafts(drafts.filter((draft) => draft.id !== activeDraftId));
    }
    resetForm("محصول با موفقیت ذخیره شد. می‌توانید محصول بعدی را ثبت کنید.");
  }

  if (definitions === null) {
    return (
      <div className="min-w-0 space-y-4">
        <SectionCardSkeleton rows={6} label="در حال آماده‌سازی فرم محصول" />
      </div>
    );
  }

  const commonPricingHint =
    form.variants.length > 0
      ? "این مقدار پیش‌فرض همهٔ تنوع‌هاست؛ در کارت هر تنوع می‌توانید آن را تغییر دهید."
      : "مبلغ و موجودی آغازین همین محصول را وارد کنید.";

  const actionButtons = (
    <>
      <Button type="submit" form="product-add-form" disabled={busy} size="lg" className="w-full font-semibold">
        <SaveIcon aria-hidden="true" className="size-4" />
        {busy ? "در حال ثبت…" : form.variants.length > 0 ? "ثبت محصول و تنوع‌ها" : "ثبت محصول"}
      </Button>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={busy || !hasContent(form)}
        onClick={stashDraft}
      >
        <RotateCcwIcon aria-hidden="true" className="size-4" />
        ذخیره پیش‌نویس و فرم جدید
      </Button>
    </>
  );

  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-5">
      <form id="product-add-form" noValidate onSubmit={save} className="min-w-0 space-y-4">
        <div aria-live="assertive">
          <ErrorBox>{error}</ErrorBox>
        </div>
        {notice ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/20 dark:text-emerald-100"
          >
            <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              {notice}{" "}
              {notice.startsWith("محصول با موفقیت") ? (
                <Link href={accountingProductsHref()} className="font-semibold text-primary underline-offset-4 hover:underline">
                  مشاهدهٔ فهرست محصولات
                </Link>
              ) : null}
            </p>
          </div>
        ) : null}
        {loadError ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-3 text-sm text-destructive">
            <p>{loadError}</p>
            <Button type="button" variant="outline" size="sm" onClick={loadDefinitions}>
              تلاش دوباره
            </Button>
          </div>
        ) : null}

        <fieldset disabled={busy} className="min-w-0 space-y-4 disabled:opacity-75">
          <SectionCard
            title="مشخصات اصلی"
            description="نام محصول الزامی است. کد کالا و بارکد را دستی وارد کنید یا بسازید."
          >
            <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label="نام محصول *">
                  <input
                    ref={nameRef}
                    className={inputClass}
                    value={form.name}
                    onChange={(event) => set("name", event.target.value)}
                    maxLength={200}
                    autoComplete="off"
                    aria-required="true"
                    aria-invalid={fieldErrors.has("name")}
                    placeholder="مثلاً پیراهن مردانه"
                  />
                  <InlineError message={fieldErrors.get("name")} />
                </Field>
              </div>

              <Field
                label={form.variants.length > 0 ? "بارکد خانواده" : "بارکد"}
                hint={
                  form.variants.length > 0
                    ? "برای محصول چندتنوعی، بارکد را داخل کارت هر تنوع وارد کنید."
                    : "بارکد دستی می‌تواند EAN-۱۳، UPC یا کد داخلی باشد."
                }
              >
                <input
                  className={inputClass}
                  dir="ltr"
                  value={form.barcode}
                  onChange={(event) => set("barcode", event.target.value)}
                  disabled={form.autoBarcode || form.variants.length > 0}
                  maxLength={256}
                  autoComplete="off"
                  aria-invalid={fieldErrors.has("barcode")}
                  placeholder={form.variants.length > 0 ? "برای خانواده استفاده نمی‌شود" : "اسکن یا ورود بارکد"}
                />
                <InlineError message={fieldErrors.get("barcode")} />
                {form.variants.length === 0 ? (
                  <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={form.autoBarcode}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        set("autoBarcode", checked);
                        if (checked) set("barcode", generatedBarcode());
                      }}
                      className="size-4 accent-amber-600"
                    />
                    ایجاد خودکار بارکد EAN-۱۳
                  </label>
                ) : null}
              </Field>

              <Field label="کد کالا" hint="کد کوتاه داخلی برای جستجو و گزارش‌ها">
                <input
                  className={inputClass}
                  dir="ltr"
                  value={form.sku}
                  onChange={(event) => set("sku", event.target.value)}
                  disabled={form.autoSku}
                  maxLength={100}
                  autoComplete="off"
                  aria-invalid={fieldErrors.has("sku")}
                  placeholder="مثلاً SH-10"
                />
                <InlineError message={fieldErrors.get("sku")} />
                <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={form.autoSku}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      set("autoSku", checked);
                      if (checked) set("sku", generatedSku());
                    }}
                    className="size-4 accent-amber-600"
                  />
                  ایجاد خودکار کد کالا
                </label>
              </Field>

              <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl bg-muted/60 px-3 text-sm text-foreground sm:col-span-2">
                <input
                  type="checkbox"
                  checked={form.notSellable}
                  onChange={(event) => set("notSellable", event.target.checked)}
                  className="size-4 accent-amber-600"
                />
                این محصول فعلاً قابل فروش نیست
              </label>
            </div>
          </SectionCard>

          <TabBar
            idPrefix="product-add"
            label="بخش‌های فرم محصول"
            tabs={TABS}
            active={tab}
            onChange={(nextTab) => {
              setTab(nextTab);
              setError("");
            }}
          />
          <TabPanel idPrefix="product-add" active={tab}>
            {tab === "pricing" ? (
              <SectionCard title="قیمت و موجودی اولیه" description={commonPricingHint}>
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label={`قیمت فروش (${money.unitLabel})`} hint="در صورت ورود، باید بیشتر از صفر باشد.">
                    <PersianNumberInput
                      value={form.sellPrice}
                      onChange={(event) => set("sellPrice", event.target.value)}
                      allowDecimal={false}
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("sellPrice")}
                      placeholder="۰"
                    />
                    <InlineError message={fieldErrors.get("sellPrice")} />
                  </Field>
                  <Field label={`قیمت خرید (${money.unitLabel})`} hint="می‌تواند بدون موجودی اولیه ثبت شود.">
                    <PersianNumberInput
                      value={form.purchasePrice}
                      onChange={(event) => set("purchasePrice", event.target.value)}
                      allowDecimal={false}
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("purchasePrice")}
                      placeholder="۰"
                    />
                    <InlineError message={fieldErrors.get("purchasePrice")} />
                  </Field>
                  <Field label="موجودی اولیه" hint="برای کالای شمارشی، مقدار اعشاری هم پذیرفته می‌شود.">
                    <PersianNumberInput
                      value={form.quantity}
                      onChange={(event) => set("quantity", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("quantity")}
                      placeholder="۰"
                    />
                    <InlineError message={fieldErrors.get("quantity")} />
                  </Field>
                </div>
              </SectionCard>
            ) : null}

            {tab === "general" ? (
              <SectionCard
                title="واحدهای محصول"
                description="اگر واحد فرعی دارید، هر سه مقدار واحد اصلی، واحد فرعی و ضریب تبدیل را کامل کنید."
              >
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Field label="واحد اصلی">
                    <input
                      className={inputClass}
                      value={form.unit}
                      onChange={(event) => set("unit", event.target.value)}
                      maxLength={50}
                      aria-invalid={fieldErrors.has("unit")}
                      placeholder="عدد"
                    />
                    <InlineError message={fieldErrors.get("unit")} />
                  </Field>
                  <Field label="واحد فرعی">
                    <input
                      className={inputClass}
                      value={form.subUnit}
                      onChange={(event) => set("subUnit", event.target.value)}
                      maxLength={50}
                      aria-invalid={fieldErrors.has("subUnit")}
                      placeholder="کارتن"
                    />
                    <InlineError message={fieldErrors.get("subUnit")} />
                  </Field>
                  <Field label="ضریب تبدیل" hint="مثلاً هر کارتن شامل ۲۴ عدد است.">
                    <PersianNumberInput
                      value={form.conversionFactor}
                      onChange={(event) => set("conversionFactor", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("conversionFactor")}
                      placeholder="۲۴"
                    />
                    <InlineError message={fieldErrors.get("conversionFactor")} />
                  </Field>
                </div>
              </SectionCard>
            ) : null}

            {tab === "order" ? (
              <SectionCard title="تنظیمات سفارش" description="نقطهٔ سفارش و محل نگهداری را برای برنامه‌ریزی خرید ثبت کنید.">
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
                  <Field label="نقطهٔ یادآوری سفارش" hint="وقتی موجودی به این مقدار رسید، یادآوری شود.">
                    <PersianNumberInput
                      value={form.reorderReminder}
                      onChange={(event) => set("reorderReminder", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("reorderReminderQty")}
                      placeholder="۵"
                    />
                    <InlineError message={fieldErrors.get("reorderReminderQty")} />
                  </Field>
                  <Field label="حداقل مقدار سفارش">
                    <PersianNumberInput
                      value={form.minOrder}
                      onChange={(event) => set("minOrder", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("minOrderQty")}
                      placeholder="۱۰"
                    />
                    <InlineError message={fieldErrors.get("minOrderQty")} />
                  </Field>
                  <Field label="زمان تحویل (روز)">
                    <PersianNumberInput
                      value={form.leadTimeDays}
                      onChange={(event) => set("leadTimeDays", event.target.value)}
                      allowDecimal={false}
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("leadTimeDays")}
                      placeholder="۳"
                    />
                    <InlineError message={fieldErrors.get("leadTimeDays")} />
                  </Field>
                  <Field label="محل نگهداری کالا">
                    <input
                      className={inputClass}
                      value={form.storageLocation}
                      onChange={(event) => set("storageLocation", event.target.value)}
                      maxLength={200}
                      aria-invalid={fieldErrors.has("storageLocation")}
                      placeholder="راهرو ۱، قفسه ۲، طبقه ۳"
                    />
                    <InlineError message={fieldErrors.get("storageLocation")} />
                  </Field>
                </div>
              </SectionCard>
            ) : null}

            {tab === "tax" ? (
              <SectionCard title="مالیات" description="درصد را بین صفر تا صد وارد کنید؛ مبلغ مالیات در قیمت‌های بالا وارد نمی‌شود.">
                <div className="grid min-w-0 gap-x-4 sm:grid-cols-2">
                  <Field label="مالیات فروش (درصد)">
                    <PersianNumberInput
                      value={form.taxSalePercent}
                      onChange={(event) => set("taxSalePercent", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("taxSalePercent")}
                      placeholder="۱۰"
                    />
                    <InlineError message={fieldErrors.get("taxSalePercent")} />
                  </Field>
                  <Field label="مالیات خرید (درصد)">
                    <PersianNumberInput
                      value={form.taxPurchasePercent}
                      onChange={(event) => set("taxPurchasePercent", event.target.value)}
                      inputMode="decimal"
                      allowDecimal
                      allowNegative={false}
                      aria-invalid={fieldErrors.has("taxPurchasePercent")}
                      placeholder="۱۰"
                    />
                    <InlineError message={fieldErrors.get("taxPurchasePercent")} />
                  </Field>
                </div>
              </SectionCard>
            ) : null}

            {tab === "attributes" ? (
              <SectionCard
                title="تنوع‌های محصول"
                description="هر تنوع یک کالای قابل فروش مستقل با ویژگی، کد، بارکد، قیمت و موجودی خودش است."
              >
                {definitions.length === 0 ? (
                  <EmptyState>
                    ویژگی فعالی تعریف نشده است. ابتدا در{" "}
                    <Link href={accountingProductsHref("attributes")} className="font-semibold text-primary underline-offset-4 hover:underline">
                      ویژگی محصول
                    </Link>{" "}
                    یک ویژگی مثل رنگ یا سایز بسازید.
                  </EmptyState>
                ) : (
                  <div className="min-w-0 space-y-4">
                    {form.variants.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
                        <Layers3Icon aria-hidden="true" className="mx-auto size-6 text-amber-700 dark:text-amber-300" />
                        <p className="mt-2 text-sm font-medium text-foreground">این محصول فعلاً ساده است.</p>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          اگر رنگ، سایز یا مدل‌های جداگانه دارد، اولین تنوع را اضافه کنید.
                        </p>
                      </div>
                    ) : null}

                    {form.variants.map((variant, index) => {
                      const variantPrefix = `variants.${index}`;
                      const rowError = issues.find(
                        (entry) => entry.field.startsWith(`${variantPrefix}.attributes`) || entry.field === variantPrefix,
                      )?.message;
                      return (
                        <section key={variant.id} className="min-w-0 rounded-xl border border-border/80 bg-muted/40 p-3 sm:p-4">
                          <div className="flex items-center justify-between gap-2 border-b border-border/80 pb-3">
                            <div className="min-w-0">
                              <h3 className="text-sm font-semibold text-foreground">تنوع {toPersianDigits(index + 1)}</h3>
                              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                {Object.values(variant.values).filter(Boolean).join("، ") || "ویژگی‌ها را انتخاب کنید"}
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                              aria-label={`حذف تنوع ${toPersianDigits(index + 1)}`}
                              onClick={() => removeVariantRow(variant.id)}
                            >
                              <Trash2Icon aria-hidden="true" className="size-4" />
                            </Button>
                          </div>

                          {rowError ? <p className="mt-3 text-xs text-destructive">{rowError}</p> : null}
                          <div className="mt-3 grid min-w-0 gap-x-3 sm:grid-cols-2 xl:grid-cols-3">
                            {definitions.map((definition) => (
                              <Field key={definition.id} label={definition.name} as={definition.options.length > 0 ? "div" : "label"}>
                                {definition.options.length > 0 ? (
                                  <SearchableSelect
                                    value={variant.values[definition.name] ?? ""}
                                    onChange={(value) =>
                                      setVariant(variant.id, {
                                        values: { ...variant.values, [definition.name]: value },
                                      })
                                    }
                                    options={[
                                      { value: "", label: "انتخاب نشده" },
                                      ...definition.options.map((option) => ({ value: option, label: option })),
                                    ]}
                                    placeholder="انتخاب کنید"
                                    ariaLabel={`ویژگی ${definition.name} برای تنوع ${toPersianDigits(index + 1)}`}
                                  />
                                ) : (
                                  <input
                                    className={inputClass}
                                    value={variant.values[definition.name] ?? ""}
                                    onChange={(event) =>
                                      setVariant(variant.id, {
                                        values: { ...variant.values, [definition.name]: event.target.value },
                                      })
                                    }
                                    maxLength={200}
                                  />
                                )}
                              </Field>
                            ))}

                            <Field label="کد کالا (اختیاری)">
                              <input
                                className={inputClass}
                                dir="ltr"
                                value={variant.sku}
                                onChange={(event) => setVariant(variant.id, { sku: event.target.value })}
                                maxLength={100}
                                autoComplete="off"
                                aria-invalid={fieldErrors.has(`${variantPrefix}.sku`)}
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.sku`)} />
                            </Field>

                            <Field label="بارکد تنوع" hint="هر بارکد در شعبه باید یکتا باشد.">
                              <input
                                className={inputClass}
                                dir="ltr"
                                value={variant.barcode}
                                onChange={(event) => setVariant(variant.id, { barcode: event.target.value })}
                                disabled={variant.autoBarcode}
                                maxLength={256}
                                autoComplete="off"
                                aria-invalid={fieldErrors.has(`${variantPrefix}.barcode`)}
                                placeholder="اسکن یا ورود بارکد"
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.barcode`)} />
                              <label className="mt-2 flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-1 text-xs text-muted-foreground">
                                <input
                                  type="checkbox"
                                  checked={variant.autoBarcode}
                                  onChange={(event) => {
                                    const checked = event.target.checked;
                                    setVariant(variant.id, {
                                      autoBarcode: checked,
                                      barcode: checked ? generatedBarcode() : variant.barcode,
                                    });
                                  }}
                                  className="size-4 accent-amber-600"
                                />
                                ایجاد خودکار بارکد
                              </label>
                            </Field>

                            <Field label={`قیمت فروش (${money.unitLabel})`} hint="خالی یعنی استفاده از قیمت پیش‌فرض بالا.">
                              <PersianNumberInput
                                value={variant.sellPrice}
                                onChange={(event) => setVariant(variant.id, { sellPrice: event.target.value })}
                                allowDecimal={false}
                                allowNegative={false}
                                aria-invalid={fieldErrors.has(`${variantPrefix}.sellPrice`)}
                                placeholder={form.sellPrice || "پیش‌فرض"}
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.sellPrice`)} />
                            </Field>
                            <Field label={`قیمت خرید (${money.unitLabel})`} hint="خالی یعنی استفاده از قیمت پیش‌فرض بالا.">
                              <PersianNumberInput
                                value={variant.purchasePrice}
                                onChange={(event) => setVariant(variant.id, { purchasePrice: event.target.value })}
                                allowDecimal={false}
                                allowNegative={false}
                                aria-invalid={fieldErrors.has(`${variantPrefix}.purchasePrice`)}
                                placeholder={form.purchasePrice || "پیش‌فرض"}
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.purchasePrice`)} />
                            </Field>
                            <Field label="موجودی اولیه" hint="خالی یعنی استفاده از موجودی پیش‌فرض بالا.">
                              <PersianNumberInput
                                value={variant.quantity}
                                onChange={(event) => setVariant(variant.id, { quantity: event.target.value })}
                                inputMode="decimal"
                                allowDecimal
                                allowNegative={false}
                                aria-invalid={fieldErrors.has(`${variantPrefix}.quantity`)}
                                placeholder={form.quantity || "پیش‌فرض"}
                              />
                              <InlineError message={fieldErrors.get(`${variantPrefix}.quantity`)} />
                            </Field>
                          </div>
                        </section>
                      );
                    })}

                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 w-full border-dashed"
                      onClick={addVariantRow}
                      disabled={form.variants.length >= 100}
                    >
                      <PlusIcon aria-hidden="true" className="size-4" />
                      {form.variants.length >= 100 ? "حداکثر ۱۰۰ تنوع ثبت شده است" : "افزودن تنوع"}
                    </Button>
                  </div>
                )}
              </SectionCard>
            ) : null}
          </TabPanel>
        </fieldset>

        <div className={`${cardClass} sticky bottom-3 z-20 grid gap-2 bg-card/95 p-3 backdrop-blur-sm lg:hidden`}>
          {actionButtons}
        </div>
      </form>

      <aside className="min-w-0 lg:sticky lg:top-4">
        <section className={`${cardClass} min-w-0 overflow-hidden`} aria-label="پیش‌نویس‌های محصول">
          <div className="border-b border-border/80 px-4 py-4">
            <div className="flex items-center gap-2">
              <BarcodeIcon aria-hidden="true" className="size-4 text-amber-700 dark:text-amber-300" />
              <h2 className="font-semibold text-foreground">پیش‌نویس‌ها</h2>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {toPersianDigits(drafts.length)}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">فقط روی همین دستگاه و برای همین شعبه نگهداری می‌شوند.</p>
          </div>

          <div className="p-3">
            {drafts.length > 0 ? (
              <ul className="max-h-[22rem] space-y-2 overflow-y-auto overscroll-contain">
                {drafts.map((draft) => {
                  const active = activeDraftId === draft.id;
                  return (
                    <li
                      key={draft.id}
                      className={`flex min-w-0 items-center gap-1 rounded-xl border px-2 py-1.5 ${
                        active
                          ? "border-amber-200 bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/20"
                          : "border-transparent bg-muted/60"
                      }`}
                    >
                      <button
                        type="button"
                        className="min-h-11 min-w-0 flex-1 px-1 text-start"
                        onClick={() => openDraft(draft)}
                        aria-current={active ? "true" : undefined}
                      >
                        <span className="block truncate text-sm font-medium text-foreground">
                          {draft.form.name.trim() || "محصول بدون نام"}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {active ? "در حال ویرایش · " : ""}{draftDate(draft.savedAt)}
                        </span>
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-10 shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`حذف پیش‌نویس ${draft.form.name.trim() || "بدون نام"}`}
                        onClick={() => removeDraft(draft.id)}
                      >
                        <Trash2Icon aria-hidden="true" className="size-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs leading-5 text-muted-foreground">
                پیش‌نویسی ذخیره نشده است.
              </p>
            )}
          </div>

          <div className="hidden space-y-2 border-t border-border/80 bg-muted/40 p-3 lg:block">{actionButtons}</div>
        </section>
      </aside>
    </div>
  );
}
