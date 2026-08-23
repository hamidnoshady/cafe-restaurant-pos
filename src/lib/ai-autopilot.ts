/**
 * Phase 31 — pure guardrail rules for autopilot. Database access, tenancy,
 * provider calls and the executors themselves live in ai-autopilot-service.ts
 * and ai-autopilot-executors.ts; the decision of whether a proposal may be
 * applied unattended lives here so it is deterministic and unit-testable.
 */

import { ACTION_CATALOG, type ActionMeta, type ActionType } from "./ai";

export const AUTOPILOT_CATEGORIES = ["inventory", "pricing", "money", "customer", "waste"] as const;
export type AutopilotCategory = (typeof AUTOPILOT_CATEGORIES)[number];

export interface AutopilotCategorySetting {
  enabled: boolean;
  /**
   * Per category: inventory = max value of one adjustment/draft PO; pricing =
   * max absolute Rial change per item; money = max discount/expense/journal
   * total. null where the category has no monetary effect.
   */
  maxAmountRial: number | null;
  /** pricing = max % price change; money = max discount %. null elsewhere. */
  maxPercent: number | null;
  maxItemsPerRun: number;
  dailyActionLimit: number;
}

/**
 * The ceiling an owner cannot configure past. Mirrored by the CHECK
 * constraints in migration 0097, so neither the UI nor a direct DB write can
 * exceed it. A mis-set number can only ever narrow autopilot, never widen it.
 */
export const AUTOPILOT_CEILINGS: Record<AutopilotCategory, AutopilotCategorySetting> = {
  inventory: { enabled: true, maxAmountRial: 50_000_000, maxPercent: null, maxItemsPerRun: 25, dailyActionLimit: 5 },
  pricing: { enabled: true, maxAmountRial: 5_000_000, maxPercent: 15, maxItemsPerRun: 10, dailyActionLimit: 10 },
  money: { enabled: true, maxAmountRial: 20_000_000, maxPercent: 20, maxItemsPerRun: 5, dailyActionLimit: 5 },
  customer: { enabled: true, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 20, dailyActionLimit: 20 },
  waste: { enabled: true, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 1, dailyActionLimit: 1 },
};

/**
 * What a category starts at once an owner switches it on. Money is tightest:
 * `expense.categorize` is the one eligible action with no one-click undo.
 */
export const AUTOPILOT_DEFAULTS: Record<AutopilotCategory, AutopilotCategorySetting> = {
  inventory: { enabled: false, maxAmountRial: 10_000_000, maxPercent: null, maxItemsPerRun: 10, dailyActionLimit: 2 },
  pricing: { enabled: false, maxAmountRial: 1_000_000, maxPercent: 5, maxItemsPerRun: 3, dailyActionLimit: 3 },
  money: { enabled: false, maxAmountRial: 5_000_000, maxPercent: 10, maxItemsPerRun: 1, dailyActionLimit: 2 },
  customer: { enabled: false, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 10, dailyActionLimit: 10 },
  waste: { enabled: false, maxAmountRial: null, maxPercent: null, maxItemsPerRun: 1, dailyActionLimit: 1 },
};

export const AUTOPILOT_CATEGORY_LABELS: Record<AutopilotCategory, string> = {
  inventory: "موجودی و انبار",
  pricing: "قیمت و منو",
  money: "مالی و تخفیف",
  customer: "پروندهٔ مشتری",
  waste: "ضایعات",
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function clampOptionalAmount(input: number | null | undefined, ceiling: number | null): number | null {
  if (ceiling === null) return null;
  if (input === null || input === undefined || !Number.isFinite(input)) return null;
  const truncated = Math.trunc(input);
  if (truncated <= 0) return null;
  return Math.min(truncated, ceiling);
}

/**
 * Applied on write AND on read, so lowering a ceiling in a later release
 * retroactively narrows every stored setting with no data migration.
 */
export function clampAutopilotSetting(
  category: AutopilotCategory,
  input: Partial<AutopilotCategorySetting>,
): AutopilotCategorySetting {
  const ceiling = AUTOPILOT_CEILINGS[category];
  const fallback = AUTOPILOT_DEFAULTS[category];
  return {
    enabled: input.enabled ?? false,
    maxAmountRial: clampOptionalAmount(input.maxAmountRial ?? fallback.maxAmountRial, ceiling.maxAmountRial),
    maxPercent: clampOptionalAmount(input.maxPercent ?? fallback.maxPercent, ceiling.maxPercent),
    maxItemsPerRun: clampNumber(input.maxItemsPerRun ?? fallback.maxItemsPerRun, 1, ceiling.maxItemsPerRun),
    dailyActionLimit: clampNumber(input.dailyActionLimit ?? fallback.dailyActionLimit, 1, ceiling.dailyActionLimit),
  };
}

export type AutopilotDecision =
  | { decision: "auto_apply" }
  | { decision: "needs_confirmation"; reasonCode: string; reasonFa: string };

/**
 * What the caps are measured against. The service supplies whatever it can
 * read; a missing value never silently passes a cap — it defers instead.
 */
export interface AutopilotAmountContext {
  /** menu.item.priceUpdate: the item's price before the change, integer Rial. */
  currentPriceRial?: number;
  /** order.discount.apply: the order subtotal a percent discount applies to. */
  orderSubtotalRial?: number;
  /** inventory.*: the computed value of the document, integer Rial. */
  documentValueRial?: number;
}

const REASONS: Record<string, string> = {
  action_not_eligible: "این اقدام هرگز به‌صورت خودکار اجرا نمی‌شود و همیشه به تأیید شما نیاز دارد.",
  category_disabled: "اجرای خودکار برای این دسته خاموش است.",
  daily_limit_reached: "سقف تعداد اجرای خودکار امروز در این دسته تکمیل شده است.",
  too_many_items: "تعداد اقلام این پیشنهاد بیش از حد مجاز اجرای خودکار است.",
  invalid_payload: "اطلاعات این پیشنهاد کامل یا معتبر نیست.",
  missing_context: "برای سنجش این پیشنهاد در برابر سقف تعیین‌شده، اطلاعات کافی در دسترس نبود.",
  price_change_too_large: "درصد تغییر قیمت بیش از سقف تعیین‌شدهٔ شماست.",
  amount_over_cap: "مبلغ این پیشنهاد بیش از سقف تعیین‌شدهٔ شماست.",
  unbalanced_entry: "بدهکار و بستانکار این سند برابر نیست.",
  payload_touches_other_fields: "این پیشنهاد فیلدهایی بیرون از یادداشت را تغییر می‌دهد.",
};

function defer(reasonCode: string): AutopilotDecision {
  return { decision: "needs_confirmation", reasonCode, reasonFa: REASONS[reasonCode] ?? REASONS.invalid_payload };
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function lineCount(payload: Record<string, unknown>): number {
  for (const key of ["lines", "items"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value.length;
  }
  return 1;
}

/**
 * The single gate between a model's proposal and an unattended write.
 *
 * `needs_confirmation` never means "dropped" — the caller still records the
 * proposal in the audit trail as an ordinary clickable one, so the owner sees
 * everything autopilot considered and can apply it by hand.
 */
export function evaluateAutopilotProposal(input: {
  meta: ActionMeta;
  payload: Record<string, unknown>;
  setting: AutopilotCategorySetting;
  appliedTodayInCategory: number;
  context: AutopilotAmountContext;
}): AutopilotDecision {
  const { meta, payload, setting, appliedTodayInCategory, context } = input;

  if (!meta.autopilotCategory || !meta.executor) return defer("action_not_eligible");
  if (!setting.enabled) return defer("category_disabled");
  if (appliedTodayInCategory >= setting.dailyActionLimit) return defer("daily_limit_reached");
  if (lineCount(payload) > setting.maxItemsPerRun) return defer("too_many_items");

  switch (meta.type) {
    case "menu.item.priceUpdate": {
      const next = finiteNumber(payload.price);
      const current = context.currentPriceRial;
      if (next === null || next <= 0) return defer("invalid_payload");
      if (current === undefined || current <= 0) return defer("missing_context");
      const delta = Math.abs(next - current);
      if (setting.maxPercent !== null && (delta / current) * 100 > setting.maxPercent) {
        return defer("price_change_too_large");
      }
      if (setting.maxAmountRial !== null && delta > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "menu.item.disable":
      return payload.isActive === false ? { decision: "auto_apply" } : defer("invalid_payload");

    case "order.discount.apply": {
      const discount = payload.discount as Record<string, unknown> | undefined;
      const value = finiteNumber(discount?.value);
      const subtotal = context.orderSubtotalRial;
      if (!discount || value === null || value <= 0) return defer("invalid_payload");
      if (subtotal === undefined || subtotal <= 0) return defer("missing_context");
      // Checked in both directions: a small percentage of a large bill can
      // breach the Rial cap, and a small amount can breach the percent cap.
      const amountRial = discount.type === "percent" ? (subtotal * value) / 100 : value;
      const percent = (amountRial / subtotal) * 100;
      if (percent > 100) return defer("invalid_payload");
      if (setting.maxPercent !== null && percent > setting.maxPercent) return defer("amount_over_cap");
      if (setting.maxAmountRial !== null && amountRial > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "expense.categorize": {
      const amount = finiteNumber(payload.amount);
      if (amount === null || amount <= 0) return defer("invalid_payload");
      if (setting.maxAmountRial !== null && amount > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "journal.manual.propose": {
      const lines = Array.isArray(payload.lines) ? (payload.lines as Record<string, unknown>[]) : null;
      if (!lines || lines.length === 0) return defer("invalid_payload");
      let debit = 0;
      let credit = 0;
      for (const line of lines) {
        const d = finiteNumber(line.debit) ?? 0;
        const c = finiteNumber(line.credit) ?? 0;
        if (d < 0 || c < 0) return defer("invalid_payload");
        debit += d;
        credit += c;
      }
      // createDraft would refuse an unbalanced entry anyway; refusing here as
      // well keeps the model's unbalanced output away from an unattended path.
      if (debit !== credit) return defer("unbalanced_entry");
      if (debit <= 0) return defer("invalid_payload");
      if (setting.maxAmountRial !== null && debit > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "inventory.reorder.draftPO":
    case "inventory.adjustment.propose": {
      const value = context.documentValueRial;
      if (value === undefined) return defer("missing_context");
      if (setting.maxAmountRial !== null && value > setting.maxAmountRial) return defer("amount_over_cap");
      return { decision: "auto_apply" };
    }

    case "customer.note.add": {
      const notes = payload.notes;
      if (typeof notes !== "string" || notes.trim().length === 0 || notes.length > 2_000) {
        return defer("invalid_payload");
      }
      // The endpoint is a full PUT on the customer, so the guard — not the
      // endpoint — is what stops a "note" proposal from quietly rewriting a
      // phone number or credit terms.
      const allowed = new Set(["customerId", "notes"]);
      if (Object.keys(payload).some((key) => !allowed.has(key))) {
        return defer("payload_touches_other_fields");
      }
      return { decision: "auto_apply" };
    }

    default:
      return defer("action_not_eligible");
  }
}

/** Action types an autopilot run for `category` may propose. */
export function actionTypesForCategory(category: AutopilotCategory): ActionType[] {
  return (Object.keys(ACTION_CATALOG) as ActionType[]).filter(
    (type) => ACTION_CATALOG[type].autopilotCategory === category,
  );
}
