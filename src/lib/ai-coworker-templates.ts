/**
 * Phase 32 — the ready-made jobs an owner can put the coworker to.
 *
 * A template is the *shape* of a recurring piece of work: what the owner has
 * to decide once (which item, which reason, which formula), what the coworker
 * must look up every time it fires (how much is actually on the shelf), and
 * which catalogue actions come out the other end.
 *
 * The builders below are pure and total: same params + same facts ⇒ same
 * actions, every night, with no provider call. That is the property that makes
 * this usable for bookkeeping at all — an owner cannot approve "whatever the
 * model felt like at 02:00" as a standing instruction, but they can approve
 * "write off the bread that is left, as spoilage".
 *
 * The load-bearing rule the builders enforce: **a quantity is read from the
 * database at fire time, never from the stored params.** The params hold the
 * owner's intent ("the bread, all of what's left, spoilage"); how much bread
 * there is on any given night is a fact only the stock table knows.
 */

import type { ActionType, ProposedAction } from "./ai";
import type { CoworkerEventKind, CoworkerTriggerKind } from "./ai-coworker";
import { filterFindings, type AccountingFinding, type AccountingReviewSeverity } from "./accounting-review";

export const COWORKER_TEMPLATE_KEYS = [
  "shift_close_waste",
  "shift_open_production",
  "shift_open_stock_topup",
  "low_stock_purchase_draft",
  "accounting_review",
  // Wave 5: one event, one customer, one queued campaign — never a model call.
  "customer_event_message",
] as const;
export type CoworkerTemplateKey = (typeof COWORKER_TEMPLATE_KEYS)[number];

export function isCoworkerTemplateKey(value: unknown): value is CoworkerTemplateKey {
  return typeof value === "string" && (COWORKER_TEMPLATE_KEYS as readonly string[]).includes(value);
}

/** What the service must load before a builder can run. Keeps the two in step. */
export type CoworkerFactKind = "inventory_on_hand" | "production_formulas" | "low_stock" | "accounting_review";

export interface CoworkerTemplateParamField {
  key: string;
  label: string;
  type: "inventory_item_lines" | "formula_lines" | "topup_lines" | "text" | "select";
  required: boolean;
  help?: string;
  options?: { value: string; label: string }[];
}

export interface CoworkerTemplate {
  key: CoworkerTemplateKey;
  title: string;
  description: string;
  /**
   * Whether one firing covers one branch or the whole business. A waste job
   * fires per branch (each store room has its own bread); an accounting review
   * reads the ledger, which is business-wide, and firing it once per branch
   * would just produce the same findings N times.
   */
  scope: "location" | "business";
  /** Which module the business must have for this template to be offered at all. */
  module: string;
  triggers: CoworkerTriggerKind[];
  suggestedTrigger: CoworkerTriggerKind;
  suggestedEvent: CoworkerEventKind | null;
  suggestedHour: number | null;
  facts: CoworkerFactKind[];
  emits: ActionType[];
  params: CoworkerTemplateParamField[];
}

export const WASTE_REASON_OPTIONS = [
  { value: "spoilage", label: "فساد و ماندگی" },
  { value: "prep_error", label: "خطای آماده‌سازی" },
  { value: "customer_return", label: "برگشت از مشتری" },
  { value: "staff_meal", label: "مصرف پرسنل" },
  { value: "other", label: "سایر" },
] as const;

const WASTE_REASONS = new Set(WASTE_REASON_OPTIONS.map((option) => option.value as string));

export const COWORKER_TEMPLATES: Record<CoworkerTemplateKey, CoworkerTemplate> = {
  shift_close_waste: {
    key: "shift_close_waste",
    title: "ثبت ضایعات پایان شیفت",
    description:
      "در پایان هر شیفت، مانده‌ی کالاهایی که انتخاب کرده‌اید را به‌عنوان ضایعات ثبت می‌کند — مثلاً نانی که ته شب می‌ماند. مقدار هر بار از موجودی واقعی همان لحظه خوانده می‌شود، نه از عددی که یک بار ذخیره شده باشد.",
    scope: "location",
    module: "inventory",
    triggers: ["event", "schedule", "manual"],
    suggestedTrigger: "event",
    suggestedEvent: "shift_close",
    suggestedHour: null,
    facts: ["inventory_on_hand"],
    emits: ["inventory.waste.log"],
    params: [
      {
        key: "items",
        label: "کالاها و دلیل ضایعات",
        type: "inventory_item_lines",
        required: true,
        help: "برای هر کالا مشخص کنید همهٔ مانده ثبت شود یا مقدار ثابتی. اگر موجودی صفر باشد، آن ردیف نادیده گرفته می‌شود.",
      },
      { key: "note", label: "یادداشت (اختیاری)", type: "text", required: false },
    ],
  },

  shift_open_production: {
    key: "shift_open_production",
    title: "ثبت تولید ابتدای شیفت",
    description:
      "با شروع شیفت، تولید داخلی روزانه را ثبت می‌کند (مثلاً پختِ نان یا کیک از روی فرمول). بهای مواد از انبار خارج و کالای تولیدشده با همان بها وارد می‌شود.",
    scope: "location",
    module: "inventory",
    triggers: ["event", "schedule", "manual"],
    suggestedTrigger: "event",
    suggestedEvent: "shift_open",
    suggestedHour: null,
    facts: ["production_formulas"],
    emits: ["inventory.production.run"],
    params: [
      {
        key: "runs",
        label: "فرمول‌ها و تعداد بچ",
        type: "formula_lines",
        required: true,
        help: "هر ردیف یک فرمول تولید و تعداد بچی است که هر بار اجرا می‌شود.",
      },
      { key: "note", label: "یادداشت (اختیاری)", type: "text", required: false },
    ],
  },

  shift_open_stock_topup: {
    key: "shift_open_stock_topup",
    title: "پیش‌نویس خرید ابتدای شیفت",
    description:
      "برای کالاهایی که هر روز به مقدار ثابتی می‌رسند (مثلاً چهل قرص نان از نانوایی)، با شروع شیفت یک پیش‌نویس خرید می‌سازد تا فقط رسید آن را بزنید. اگر کالا را خودتان تولید می‌کنید، به‌جای این قالب از «ثبت تولید ابتدای شیفت» استفاده کنید.",
    scope: "location",
    module: "inventory",
    triggers: ["event", "schedule", "manual"],
    suggestedTrigger: "event",
    suggestedEvent: "shift_open",
    suggestedHour: null,
    facts: ["inventory_on_hand"],
    emits: ["inventory.reorder.draftPO"],
    params: [
      {
        key: "lines",
        label: "کالاها، مقدار و بهای هر بار",
        type: "topup_lines",
        required: true,
        help: "مقدار در واحد خرید کالا و مبلغ کل به ریال. این ارقام قرارداد شما با تأمین‌کننده است، پس از پارامترها خوانده می‌شود نه از انبار.",
      },
      { key: "note", label: "یادداشت (اختیاری)", type: "text", required: false },
    ],
  },

  low_stock_purchase_draft: {
    key: "low_stock_purchase_draft",
    title: "پیش‌نویس خرید کالاهای زیر نقطهٔ سفارش",
    description:
      "هر کالایی که به نقطهٔ سفارش رسیده باشد را جمع می‌کند و یک پیش‌نویس سفارش خرید می‌سازد؛ مقدار پیشنهادی تا رسیدن به نقطهٔ سفارش و بهای آخرین خرید همان کالا محاسبه می‌شود.",
    scope: "location",
    module: "inventory",
    triggers: ["schedule", "event", "manual"],
    suggestedTrigger: "schedule",
    suggestedEvent: null,
    suggestedHour: 9,
    facts: ["low_stock"],
    emits: ["inventory.reorder.draftPO"],
    params: [{ key: "note", label: "یادداشت (اختیاری)", type: "text", required: false }],
  },

  accounting_review: {
    key: "accounting_review",
    title: "بازبینی حساب‌ها و یافتن اشکال",
    description:
      "دفترها را بررسی می‌کند و اشکال‌های واقعی را فهرست می‌کند: سند نامتوازن، پیش‌نویس معطل‌مانده، رویداد انباری ثبت‌نشده در دفتر، کسری/اضافهٔ صندوق، سرفصل جاافتاده و مانند این‌ها — هرکدام با پیشنهاد اصلاح و لینک همان صفحه. چیزی را خودش تغییر نمی‌دهد.",
    scope: "business",
    module: "ledger",
    triggers: ["schedule", "manual", "event"],
    suggestedTrigger: "schedule",
    suggestedEvent: null,
    suggestedHour: 8,
    facts: ["accounting_review"],
    emits: [],
    params: [
      {
        key: "minSeverity",
        label: "کمترین درجهٔ اهمیت برای گزارش",
        type: "select",
        required: false,
        options: [
          { value: "high", label: "فقط موارد بحرانی" },
          { value: "medium", label: "بحرانی و مهم" },
          { value: "low", label: "همهٔ موارد" },
        ],
      },
    ],
  },

  customer_event_message: {
    key: "customer_event_message",
    title: "صف‌کردن پیام رویدادی مشتری",
    description: "در رخداد انتخاب‌شده (تولد، سه ماه بی‌مراجعگی یا آماده‌شدن سفارش) فقط برای همان مشتری یک کمپین تک‌نفره می‌سازد. متن از الگوی ذخیره‌شده می‌آید و ارسال هرگز در خود کار همکار انجام نمی‌شود.",
    scope: "business",
    module: "messaging",
    triggers: ["event"],
    suggestedTrigger: "event",
    suggestedEvent: "customer_birthday",
    suggestedHour: null,
    facts: [],
    emits: ["messaging.campaign.trigger"],
    params: [
      { key: "channel", label: "کانال", type: "select", required: true, options: [{ value: "sms", label: "پیامک" }, { value: "email", label: "ایمیل" }] },
      { key: "templateId", label: "شناسهٔ الگوی پیام", type: "text", required: true, help: "شناسه را از فهرست الگوها در صفحهٔ پیام‌رسانی بردارید؛ هنگام اجرا دوباره مالکیت و کانال آن بررسی می‌شود." },
      { key: "projectId", label: "شناسهٔ پروژه / مرکز هزینه (اختیاری)", type: "text", required: false },
    ],
  },
};

export const COWORKER_TEMPLATE_LIST: CoworkerTemplate[] = Object.values(COWORKER_TEMPLATES);

// ---------------------------------------------------------------------------
// Facts — exactly what the service loads, and nothing a builder may invent
// ---------------------------------------------------------------------------

export interface InventoryOnHandFact {
  id: string;
  name: string;
  unit: string;
  /** Decimal text, not a float — a kg-counted store room drifts otherwise. */
  onHandQty: string;
  /** Integer Rial, the current layer cost. Used to price a write-off for the cap. */
  unitCostRial: number;
}

export interface ProductionFormulaFact {
  id: string;
  name: string;
  outputItemName: string;
  isActive: boolean;
  /** Integer Rial: what one batch's inputs are currently worth. */
  batchCostRial: number;
}

export interface LowStockFact {
  id: string;
  name: string;
  unit: string;
  onHandQty: string;
  reorderLevel: string;
  /** Decimal text in the item's PURCHASE unit — the shape createDraftPurchase wants. */
  suggestedPurchaseQty: string;
  /** Integer Rial for the whole suggested quantity, from the last purchase price. */
  suggestedTotalCostRial: number;
  supplierId: string | null;
}

export interface TriggeredCustomerFact {
  customerId: string;
  eventKind: "customer_birthday" | "customer_inactive_3_months" | "order_ready";
  /** An order-ready notification carries the order reference for its audit summary. */
  orderId?: string;
}

export interface CoworkerFacts {
  onHand?: Record<string, InventoryOnHandFact>;
  /** Present only for the deterministic one-customer messaging template. */
  triggerCustomer?: TriggeredCustomerFact;
  formulas?: Record<string, ProductionFormulaFact>;
  lowStock?: LowStockFact[];
  review?: AccountingFinding[];
  /**
   * Checks whose query could not run this time. Carried alongside the findings
   * so a review that half-ran cannot report itself as "nothing wrong" — the
   * same reason `runAccountingReview` returns the list at all.
   */
  reviewUnavailableChecks?: string[];
}

export interface CoworkerBuildResult {
  actions: ProposedAction[];
  /** Set when the job legitimately had nothing to do — not an error. */
  skipReason?: string;
  /** A report-shaped run (the accounting review) puts its output here. */
  report?: { findings: AccountingFinding[] };
}

// ---------------------------------------------------------------------------
// Parameter validation
// ---------------------------------------------------------------------------

function asRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every((row) => typeof row === "object" && row !== null && !Array.isArray(row))) return null;
  return value as Record<string, unknown>[];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Positive decimal *text*. Rejects NaN/Infinity/negatives without going through a float. */
function positiveDecimalText(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text) > 0 ? text : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function validateTemplateParams(key: CoworkerTemplateKey, params: Record<string, unknown>): string[] {
  const errors: string[] = [];

  switch (key) {
    case "shift_close_waste": {
      const items = asRecordArray(params.items);
      if (!items) return ["coworker_params_items_required"];
      for (const item of items) {
        if (!nonEmptyString(item.inventoryItemId)) errors.push("coworker_params_item_invalid");
        if (!WASTE_REASONS.has(String(item.reason))) errors.push("coworker_params_reason_invalid");
        if (item.mode !== "remaining" && item.mode !== "fixed") errors.push("coworker_params_mode_invalid");
        if (item.mode === "fixed" && positiveDecimalText(item.quantity) === null) {
          errors.push("coworker_params_quantity_invalid");
        }
      }
      break;
    }
    case "shift_open_production": {
      const runs = asRecordArray(params.runs);
      if (!runs) return ["coworker_params_runs_required"];
      for (const run of runs) {
        if (!nonEmptyString(run.formulaId)) errors.push("coworker_params_formula_invalid");
        if (positiveDecimalText(run.batches) === null) errors.push("coworker_params_batches_invalid");
      }
      break;
    }
    case "shift_open_stock_topup": {
      const lines = asRecordArray(params.lines);
      if (!lines) return ["coworker_params_lines_required"];
      for (const line of lines) {
        if (!nonEmptyString(line.inventoryItemId)) errors.push("coworker_params_item_invalid");
        if (positiveDecimalText(line.purchaseQty) === null) errors.push("coworker_params_quantity_invalid");
        if (positiveInteger(line.totalCostRial) === null) errors.push("coworker_params_cost_invalid");
      }
      break;
    }
    case "low_stock_purchase_draft":
      break;
    case "accounting_review": {
      const severity = params.minSeverity;
      if (severity !== undefined && severity !== "high" && severity !== "medium" && severity !== "low") {
        errors.push("coworker_params_severity_invalid");
      }
      break;
    }
    case "customer_event_message": {
      if (params.channel !== "sms" && params.channel !== "email") errors.push("coworker_params_message_channel_invalid");
      if (!nonEmptyString(params.templateId)) errors.push("coworker_params_message_template_invalid");
      if (params.projectId !== undefined && !nonEmptyString(params.projectId)) errors.push("coworker_params_project_invalid");
      break;
    }
  }

  return Array.from(new Set(errors));
}

export const TEMPLATE_PARAM_ERROR_MESSAGES: Record<string, string> = {
  coworker_params_items_required: "دست‌کم یک کالا برای ثبت ضایعات انتخاب کنید.",
  coworker_params_runs_required: "دست‌کم یک فرمول تولید انتخاب کنید.",
  coworker_params_lines_required: "دست‌کم یک ردیف کالا وارد کنید.",
  coworker_params_item_invalid: "کالای انتخاب‌شده معتبر نیست.",
  coworker_params_reason_invalid: "دلیل ضایعات معتبر نیست.",
  coworker_params_mode_invalid: "مشخص کنید همهٔ مانده ثبت شود یا مقدار ثابت.",
  coworker_params_quantity_invalid: "مقدار باید عددی بزرگ‌تر از صفر باشد.",
  coworker_params_cost_invalid: "مبلغ باید عددی صحیح و بزرگ‌تر از صفر باشد.",
  coworker_params_formula_invalid: "فرمول تولید معتبر نیست.",
  coworker_params_batches_invalid: "تعداد بچ باید بزرگ‌تر از صفر باشد.",
  coworker_params_severity_invalid: "درجهٔ اهمیت معتبر نیست.",
  coworker_params_message_channel_invalid: "کانال پیام باید پیامک یا ایمیل باشد.",
  coworker_params_message_template_invalid: "شناسهٔ الگوی پیام لازم است.",
  coworker_params_project_invalid: "شناسهٔ پروژه معتبر نیست.",
};

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Compares two positive decimal texts without going through a float. */
function compareDecimalText(a: string, b: string): number {
  const [aInt, aFrac = ""] = a.split(".");
  const [bInt, bFrac = ""] = b.split(".");
  const aI = aInt.replace(/^0+(?=\d)/, "");
  const bI = bInt.replace(/^0+(?=\d)/, "");
  if (aI.length !== bI.length) return aI.length - bI.length;
  if (aI !== bI) return aI < bI ? -1 : 1;
  const width = Math.max(aFrac.length, bFrac.length);
  const aF = aFrac.padEnd(width, "0");
  const bF = bFrac.padEnd(width, "0");
  if (aF === bF) return 0;
  return aF < bF ? -1 : 1;
}

function isPositiveDecimal(text: string): boolean {
  return /^\d+(\.\d+)?$/.test(text) && /[1-9]/.test(text);
}

function buildWaste(params: Record<string, unknown>, facts: CoworkerFacts): CoworkerBuildResult {
  const onHand = facts.onHand ?? {};
  const note = nonEmptyString(params.note);
  const rows = asRecordArray(params.items) ?? [];
  const actions: ProposedAction[] = [];
  const skipped: string[] = [];

  for (const row of rows) {
    const itemId = nonEmptyString(row.inventoryItemId);
    if (!itemId) continue;
    const item = onHand[itemId];
    if (!item) {
      skipped.push("کالایی که دیگر در انبار این شعبه نیست");
      continue;
    }
    // The single most important line in this file: what is on the shelf now,
    // not what the owner typed when they created the job.
    const available = item.onHandQty;
    if (!isPositiveDecimal(available)) {
      skipped.push(item.name);
      continue;
    }
    let quantity: string;
    if (row.mode === "fixed") {
      const wanted = positiveDecimalText(row.quantity);
      if (!wanted) continue;
      // Never write off more than exists — that would open a negative layer at
      // a price nobody paid, which is a costing bug, not a write-off.
      quantity = compareDecimalText(wanted, available) > 0 ? available : wanted;
    } else {
      quantity = available;
    }

    actions.push({
      type: "inventory.waste.log",
      title: `ضایعات ${item.name}`,
      summary: `${quantity} ${item.unit} از «${item.name}» به‌عنوان ضایعات ثبت می‌شود.`,
      payload: {
        inventoryItemId: itemId,
        quantity,
        reason: String(row.reason),
        note: note ?? "ضایعات پایان شیفت",
      },
    });
  }

  if (actions.length === 0) {
    return {
      actions,
      skipReason: skipped.length
        ? "موجودی هیچ‌کدام از کالاهای انتخاب‌شده باقی نمانده بود، پس ضایعاتی ثبت نشد."
        : "کالایی برای ثبت ضایعات پیدا نشد.",
    };
  }
  return { actions };
}

function buildProduction(params: Record<string, unknown>, facts: CoworkerFacts): CoworkerBuildResult {
  const formulas = facts.formulas ?? {};
  const note = nonEmptyString(params.note);
  const rows = asRecordArray(params.runs) ?? [];
  const actions: ProposedAction[] = [];

  for (const row of rows) {
    const formulaId = nonEmptyString(row.formulaId);
    const batches = positiveDecimalText(row.batches);
    if (!formulaId || !batches) continue;
    const formula = formulas[formulaId];
    // An inactive or deleted formula is skipped rather than guessed at: Phase
    // 29's own service would refuse it, and refusing here keeps the run's
    // summary honest about what it did not do.
    if (!formula || !formula.isActive) continue;

    actions.push({
      type: "inventory.production.run",
      title: `تولید ${formula.outputItemName}`,
      summary: `${batches} بچ از فرمول «${formula.name}» ثبت می‌شود.`,
      payload: { formulaId, batches, note: note ?? "تولید ابتدای شیفت" },
    });
  }

  if (actions.length === 0) {
    return { actions, skipReason: "هیچ فرمول فعالی برای اجرا پیدا نشد." };
  }
  return { actions };
}

function buildStockTopUp(params: Record<string, unknown>, facts: CoworkerFacts): CoworkerBuildResult {
  const onHand = facts.onHand ?? {};
  const note = nonEmptyString(params.note);
  const rows = asRecordArray(params.lines) ?? [];
  const items: Record<string, unknown>[] = [];
  const names: string[] = [];

  for (const row of rows) {
    const itemId = nonEmptyString(row.inventoryItemId);
    const purchaseQty = positiveDecimalText(row.purchaseQty);
    const totalCost = positiveInteger(row.totalCostRial);
    if (!itemId || !purchaseQty || totalCost === null) continue;
    if (!onHand[itemId]) continue;
    items.push({ inventoryItemId: itemId, purchaseQty, totalCost: String(totalCost) });
    names.push(onHand[itemId].name);
  }

  if (items.length === 0) {
    return { actions: [], skipReason: "هیچ‌کدام از کالاهای این کار در انبار این شعبه پیدا نشد." };
  }

  return {
    actions: [
      {
        type: "inventory.reorder.draftPO",
        title: "پیش‌نویس خرید ابتدای شیفت",
        summary: `پیش‌نویس خرید برای ${items.length} کالا (${names.join("، ")}) ساخته می‌شود.`,
        payload: { note: note ?? "خرید روزانهٔ ابتدای شیفت", items },
      },
    ],
  };
}

function buildLowStockDraft(params: Record<string, unknown>, facts: CoworkerFacts): CoworkerBuildResult {
  const low = facts.lowStock ?? [];
  if (low.length === 0) {
    return { actions: [], skipReason: "هیچ کالایی به نقطهٔ سفارش نرسیده است." };
  }
  const note = nonEmptyString(params.note);
  // One draft per supplier: a purchase document belongs to one supplier, and
  // merging two suppliers' lines into one draft would make it unreceivable.
  const bySupplier = new Map<string, LowStockFact[]>();
  for (const item of low) {
    const key = item.supplierId ?? "";
    const bucket = bySupplier.get(key);
    if (bucket) bucket.push(item);
    else bySupplier.set(key, [item]);
  }

  const actions: ProposedAction[] = [];
  for (const [supplierId, group] of bySupplier) {
    actions.push({
      type: "inventory.reorder.draftPO",
      title: "پیش‌نویس خرید کالاهای زیر نقطهٔ سفارش",
      summary: `${group.length} کالا: ${group.map((item) => item.name).join("، ")}`,
      payload: {
        ...(supplierId ? { supplierId } : {}),
        note: note ?? "کالاهای رسیده به نقطهٔ سفارش",
        items: group.map((item) => ({
          inventoryItemId: item.id,
          purchaseQty: item.suggestedPurchaseQty,
          totalCost: String(item.suggestedTotalCostRial),
        })),
      },
    });
  }
  return { actions };
}

function buildTriggeredCustomerMessage(params: Record<string, unknown>, facts: CoworkerFacts): CoworkerBuildResult {
  const trigger = facts.triggerCustomer;
  const templateId = nonEmptyString(params.templateId);
  const channel = params.channel === "sms" || params.channel === "email" ? params.channel : null;
  if (!trigger || !templateId || !channel) {
    return { actions: [], skipReason: "اطلاعات مشتری یا الگوی پیام این رویداد دیگر در دسترس نیست." };
  }
  const eventNames: Record<TriggeredCustomerFact["eventKind"], string> = {
    customer_birthday: "تولد مشتری", customer_inactive_3_months: "سه ماه بی‌مراجعگی مشتری", order_ready: "آماده‌شدن سفارش",
  };
  return {
    actions: [{
      type: "messaging.campaign.trigger",
      title: `صف‌کردن پیام ${eventNames[trigger.eventKind]}`,
      summary: `یک پیام ${channel === "sms" ? "پیامکی" : "ایمیلی"} برای مشتری رویداد «${eventNames[trigger.eventKind]}» در صف قرار می‌گیرد.`,
      payload: {
        customerId: trigger.customerId, templateId, channel, eventKind: trigger.eventKind,
        ...(nonEmptyString(params.projectId) ? { projectId: nonEmptyString(params.projectId)! } : {}),
        ...(trigger.orderId ? { orderId: trigger.orderId } : {}),
      },
    }],
  };
}

function buildAccountingReview(params: Record<string, unknown>, facts: CoworkerFacts): CoworkerBuildResult {
  const floor = (params.minSeverity as AccountingReviewSeverity | undefined) ?? "medium";
  const findings = filterFindings(facts.review ?? [], floor);
  if (findings.length === 0) {
    const degraded = facts.reviewUnavailableChecks?.length ?? 0;
    return {
      actions: [],
      skipReason: degraded
        ? `در بررسی‌هایی که انجام شد اشکالی پیدا نشد، اما ${degraded} بررسی این نوبت انجام نشد.`
        : "در این بازبینی اشکالی پیدا نشد.",
    };
  }
  // A report, never a write. Every finding carries where to go and what to do;
  // deciding *which* correcting entry to post is the accountant's call, and a
  // job that posts it unattended would be the exact opposite of a review.
  return { actions: [], report: { findings } };
}

export function buildCoworkerActions(
  key: CoworkerTemplateKey,
  params: Record<string, unknown>,
  facts: CoworkerFacts,
): CoworkerBuildResult {
  switch (key) {
    case "shift_close_waste":
      return buildWaste(params, facts);
    case "shift_open_production":
      return buildProduction(params, facts);
    case "shift_open_stock_topup":
      return buildStockTopUp(params, facts);
    case "low_stock_purchase_draft":
      return buildLowStockDraft(params, facts);
    case "accounting_review":
      return buildAccountingReview(params, facts);
    case "customer_event_message":
      return buildTriggeredCustomerMessage(params, facts);
  }
}
