/**
 * Framework-free core for the AI assistant: provider metadata, the confirmed-
 * action allowlist, system prompts, and the OpenAI-compatible tool definitions.
 *
 * Both supported providers (OpenRouter and ArvanCloud AI) speak the OpenAI
 * `/chat/completions` shape, so the whole design is a single provider-agnostic
 * client whose base URL / model / key are configurable. Nothing here touches the
 * DB, the network, or `next/*` — that lives in ai-service.ts / ai-config.ts so
 * this module stays unit-testable (see ai.test.ts).
 */

// Type-only, so the value dependency stays one-way: ai-autopilot.ts imports
// ACTION_CATALOG from here, never the reverse.
import type { AutopilotCategory } from "./ai-autopilot";

export type AiProvider = "openrouter" | "arvan";

export interface ProviderMeta {
  id: AiProvider;
  /** Persian label for the settings UI. */
  label: string;
  /** Default OpenAI-compatible base URL (user-overridable). */
  defaultBaseUrl: string;
  /** A reasonable default model id for this provider. */
  defaultModel: string;
  /** Env var the key falls back to when no DB value is stored. */
  keyEnv: string;
}

export const PROVIDERS: Record<AiProvider, ProviderMeta> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    keyEnv: "OPENROUTER_API_KEY",
  },
  arvan: {
    id: "arvan",
    label: "هوش مصنوعی آروان‌کلاد",
    // ArvanCloud's AI gateway is OpenAI-compatible; the exact host can differ by
    // plan/region, so this is only a default — it is editable in the settings UI.
    defaultBaseUrl: "https://ai.arvancloud.ir/v1",
    defaultModel: "gpt-4o-mini",
    keyEnv: "ARVAN_AI_API_KEY",
  },
};

export function isProvider(v: unknown): v is AiProvider {
  return v === "openrouter" || v === "arvan";
}

export interface AiConfig {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** 0..2, defaults 0.3 for a grounded assistant. */
  temperature: number;
  /** Platform cap sent to the provider for one completion. */
  maxOutputTokens?: number;
}

/** Config safe to send to the browser — the key is never exposed, only a hint. */
export interface PublicAiConfig {
  enabled: boolean;
  provider: AiProvider;
  model: string;
  baseUrl: string;
  temperature: number;
  hasKey: boolean;
  /** last 4 chars of the stored key, for "is the right key set?" reassurance */
  keyHint: string | null;
}

export function defaultConfig(provider: AiProvider = "openrouter"): AiConfig {
  const meta = PROVIDERS[provider];
  return {
    enabled: false,
    provider,
    model: meta.defaultModel,
    baseUrl: meta.defaultBaseUrl,
    apiKey: "",
    temperature: 0.3,
    maxOutputTokens: 1000,
  };
}

export function toPublicConfig(config: AiConfig): PublicAiConfig {
  const key = config.apiKey ?? "";
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    temperature: config.temperature,
    hasKey: key.length > 0,
    keyHint: key.length >= 4 ? key.slice(-4) : null,
  };
}

/** Join a base URL with the chat-completions path, tolerating a trailing slash. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export interface ConfigInput {
  enabled?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
}

/** Validate a config PUT body. Returns error codes (see errorMessage maps). */
export function validateConfigInput(input: ConfigInput): string[] {
  const errors: string[] = [];
  if (!isProvider(input.provider)) errors.push("ai_bad_provider");
  if (!input.model || !input.model.trim()) errors.push("ai_bad_model");
  const base = input.baseUrl?.trim() ?? "";
  if (!/^https?:\/\/.+/i.test(base)) errors.push("ai_bad_base_url");
  if (input.temperature != null) {
    const t = Number(input.temperature);
    if (!Number.isFinite(t) || t < 0 || t > 2) errors.push("ai_bad_temperature");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Confirmed-action allowlist
//
// The agent never mutates data on its own. When it wants to change something it
// emits a `propose_action` tool call whose `type` MUST be one of these keys; the
// browser renders the proposal and only POSTs the payload to the mapped endpoint
// after the human presses "Apply". Keeping the map here (shared by server
// validation and client execution) means the model can only ever trigger a
// known, already role-guarded endpoint — never an arbitrary URL.
// ---------------------------------------------------------------------------

export type ActionType =
  | "setup.business"
  | "setup.accounts"
  | "setup.costing"
  | "setup.tax"
  | "setup.menu.category"
  | "setup.menu.item"
  // Phase 18b Wave 2 — dashboard-mode mutation catalogue, each mapping to an
  // already role-guarded existing endpoint (see ai.test.ts + the phase doc's
  // Wave 2 status section for the six actions NOT here — genuine schema gaps,
  // not a wiring omission).
  | "menu.item.priceUpdate"
  | "menu.item.disable"
  | "order.discount.apply"
  | "inventory.reorder.draftPO"
  | "inventory.adjustment.propose"
  | "reservation.create"
  | "reservation.reschedule"
  | "table.merge"
  | "table.split"
  | "courier.assign"
  | "customer.note.add"
  | "journal.manual.propose"
  | "expense.categorize"
  // Phase 32 — the three the coworker needed and the catalogue never had.
  // `inventory.waste.log` reverses a Phase 31 decision *narrowly*: waste was
  // detect-and-flag-only because "why did this stock leave" is a fact only a
  // person in the room has. A coworker job carries exactly that fact, chosen
  // by the owner in advance ("bread, end of night, spoilage"), so the missing
  // half is supplied by a human — just earlier than the write.
  | "inventory.waste.log"
  | "inventory.production.run"
  | "menu.item.create";

/**
 * Phase 31 — which server-side executor can run an action without a browser.
 * Keyed rather than inlined so ai.ts stays free of database imports.
 */
export type AutopilotExecutorKey =
  | "menuItemPatch"
  | "stockCount"
  | "draftPurchase"
  | "orderDiscount"
  | "expense"
  | "journalDraft"
  | "customerNote"
  | "wasteLog"
  | "productionRun";

export interface ActionMeta {
  type: ActionType;
  /**
   * The endpoint path. May contain `{paramName}` placeholders (e.g.
   * `/api/orders/{orderId}`) for actions on an existing resource — the model
   * must include that field in `payload`; see `resolveActionEndpoint`, which
   * substitutes it before the client's "Apply" button fetches it.
   */
  endpoint: string;
  method: "POST" | "PATCH" | "PUT";
  /** Persian label shown on the confirm card. */
  label: string;
  /** Which wizard step this completes, if any (drives "advance" after apply). */
  wizardStep?: string;
  /** Human-readable description of the expected payload, injected into the prompt. */
  payloadHint: string;
  /**
   * Phase 31 — the risk grouping an owner switches autopilot on for. Absent
   * means the action is manual-only forever, whatever the owner has enabled:
   * the six one-time setup-wizard actions, and the five live floor actions
   * (reservations, tables, courier) that a tick running 15 minutes behind the
   * room has no way to judge.
   */
  autopilotCategory?: AutopilotCategory;
  /** Present only where a server-side executor exists. See ai-autopilot-executors.ts. */
  executor?: AutopilotExecutorKey;
  /**
   * Phase 32 — eligible for an unattended write, but only when a *human*
   * authored the job that proposes it. This keeps Phase 31's decision intact
   * where it was right: `actionTypesForCategory` (which builds an autopilot
   * run's own catalogue) excludes these, so the model still never discovers on
   * its own that some stock should be written off. A coworker job may, because
   * the owner wrote down which item and why before the night began.
   */
  coworkerOnly?: boolean;
  /**
   * Whether an applied instance can be undone in one click. "while_open" =
   * only until the bill is settled; false = no one-click undo exists.
   */
  revertible?: "always" | "while_open" | false;
}

export const ACTION_CATALOG: Record<ActionType, ActionMeta> = {
  "setup.business": {
    type: "setup.business",
    endpoint: "/api/setup/business",
    method: "POST",
    label: "ثبت اطلاعات کسب‌وکار",
    wizardStep: "business",
    payloadHint:
      '{ businessName: string, locationName: string, address?: string, phone?: string, currencyDisplay?: "toman"|"rial" }',
  },
  "setup.accounts": {
    type: "setup.accounts",
    endpoint: "/api/setup/accounts",
    method: "POST",
    label: "ایجاد سرفصل حساب‌ها",
    wizardStep: "accounts",
    payloadHint:
      "{ accounts: Array<{ code: string, name: string, type: string, parentCode?: string }> } — پیشنهاد: قالب پیش‌فرض را از get_setup_state/ابزارها بگیر و بدون تغییر بفرست",
  },
  "setup.costing": {
    type: "setup.costing",
    endpoint: "/api/setup/costing",
    method: "POST",
    label: "انتخاب روش قیمت‌گذاری موجودی",
    wizardStep: "costing",
    payloadHint: '{ method: "fifo" | "weighted_average" }',
  },
  "setup.tax": {
    type: "setup.tax",
    endpoint: "/api/setup/tax",
    method: "POST",
    label: "تنظیم نرخ مالیات",
    wizardStep: "tax",
    payloadHint: "{ defaultRate: number /* percent 0..100 */ }",
  },
  "setup.menu.category": {
    type: "setup.menu.category",
    endpoint: "/api/setup/menu",
    method: "POST",
    label: "افزودن دستهٔ منو",
    wizardStep: "menu",
    payloadHint: "{ addCategory: { name: string } }",
  },
  "setup.menu.item": {
    type: "setup.menu.item",
    endpoint: "/api/setup/menu",
    method: "POST",
    label: "افزودن آیتم منو",
    wizardStep: "menu",
    payloadHint:
      "{ addItem: { categoryId: string, name: string, price: number /* integer Rial */, description?: string, sku?: string } }",
  },

  // -- Phase 18b Wave 2 -------------------------------------------------------
  "menu.item.priceUpdate": {
    type: "menu.item.priceUpdate",
    endpoint: "/api/menu/items/{menuItemId}",
    method: "PATCH",
    label: "تغییر قیمت آیتم منو",
    payloadHint: "{ menuItemId: string, price: number /* integer Rial */ }",
    autopilotCategory: "pricing",
    executor: "menuItemPatch",
    revertible: "always",
  },
  "menu.item.disable": {
    type: "menu.item.disable",
    endpoint: "/api/menu/items/{menuItemId}",
    method: "PATCH",
    label: "غیرفعال کردن آیتم منو",
    payloadHint: "{ menuItemId: string, isActive: false }",
    autopilotCategory: "pricing",
    executor: "menuItemPatch",
    revertible: "always",
  },
  "order.discount.apply": {
    type: "order.discount.apply",
    endpoint: "/api/orders/{orderId}",
    method: "PATCH",
    label: "اعمال تخفیف روی سفارش باز",
    payloadHint:
      '{ orderId: string, discount: { type: "percent"|"amount", value: number } } — فقط روی سفارش باز (status=open) اجرا می‌شود',
    autopilotCategory: "money",
    executor: "orderDiscount",
    // Undo recomputes the order's totals, which only an open order accepts.
    revertible: "while_open",
  },
  "inventory.reorder.draftPO": {
    type: "inventory.reorder.draftPO",
    endpoint: "/api/inventory/purchases",
    method: "POST",
    label: "ثبت پیش‌نویس سفارش خرید",
    payloadHint:
      '{ supplierId?: string, note?: string, items: Array<{ inventoryItemId: string, purchaseQty: string /* در واحد خرید کالا */, totalCost: string /* مبلغ کل ریال به‌صورت رشته */ }> }',
    autopilotCategory: "inventory",
    executor: "draftPurchase",
    // A draft has no stock or ledger effect, so cancelling it is a clean undo.
    revertible: "always",
  },
  "inventory.adjustment.propose": {
    type: "inventory.adjustment.propose",
    endpoint: "/api/inventory/stock-counts",
    method: "POST",
    label: "ثبت شمارش و تعدیل موجودی",
    payloadHint:
      "{ note?: string, lines: Array<{ inventoryItemId: string, countedQty: number|string /* مقدار شمارش‌شدهٔ واقعی */ }> }",
    autopilotCategory: "inventory",
    executor: "stockCount",
    revertible: "always",
  },
  "reservation.create": {
    type: "reservation.create",
    endpoint: "/api/reservations",
    method: "POST",
    label: "ثبت رزرو جدید",
    payloadHint:
      '{ tableId?: string, customerName: string, customerPhone?: string, partySize: number, reservedAt: string /* ISO */, durationMinutes?: number, note?: string, allowConflict?: boolean }',
  },
  "reservation.reschedule": {
    type: "reservation.reschedule",
    endpoint: "/api/reservations/{reservationId}",
    method: "PATCH",
    label: "تغییر زمان یا میز رزرو",
    payloadHint:
      "{ reservationId: string, reservedAt?: string, durationMinutes?: number, tableId?: string|null, allowConflict?: boolean }",
  },
  "table.merge": {
    type: "table.merge",
    endpoint: "/api/table-sessions/{tableSessionId}",
    method: "PATCH",
    label: "ادغام میز به یک نشست باز",
    payloadHint: '{ tableSessionId: string, action: "merge", tableId: string }',
  },
  "table.split": {
    type: "table.split",
    endpoint: "/api/table-sessions/{tableSessionId}/split",
    method: "POST",
    label: "تقسیم صورت‌حساب میز",
    payloadHint:
      '{ tableSessionId: string, mode: "even"|"itemized", guests: number, assignments?: Record<string, number> /* itemized فقط: orderItemId → شمارهٔ مهمان */ }',
  },
  "courier.assign": {
    type: "courier.assign",
    endpoint: "/api/deliveries/{deliveryId}",
    method: "PATCH",
    label: "تخصیص پیک به سفارش تحویل",
    payloadHint: '{ deliveryId: string, action: "assign", courierId: string|null }',
  },
  "customer.note.add": {
    type: "customer.note.add",
    endpoint: "/api/customers/{customerId}",
    method: "PUT",
    label: "افزودن یادداشت به پروفایل مشتری",
    payloadHint:
      "{ customerId: string, notes: string /* این فیلد کل یادداشت‌ها را جایگزین می‌کند — متن قبلی (از get_customer_profile) را با یادداشت جدید ترکیب کن */ }",
    // An internal note on the business's own record reaches nobody, so it may
    // autopilot. Nothing that leaves the business (a message to a customer)
    // ever does — see Phase 31 Decision 2.
    autopilotCategory: "customer",
    executor: "customerNote",
    revertible: "always",
  },
  "journal.manual.propose": {
    type: "journal.manual.propose",
    endpoint: "/api/ledger/entries/drafts",
    method: "POST",
    label: "پیش‌نویس سند حسابداری دستی",
    payloadHint:
      "{ entryDate?: string, memo: string, lines: Array<{ accountId: string, debit?: number, credit?: number }> } — مجموع بدهکار باید با مجموع بستانکار برابر باشد؛ فقط به‌صورت پیش‌نویس ثبت می‌شود و برای اعمال روی دفتر نیاز به تأیید جداگانه دارد",
    // Autopilot here means the DRAFT is created without a chat round-trip. It
    // is never posted: Phase 16's approval queue exists so no single actor both
    // writes and posts an entry, which holds whether a human or the agent
    // drafted it. ai.test.ts pins this endpoint so it can't be repointed at
    // the approve route. See Phase 31 Decision 1.
    autopilotCategory: "money",
    executor: "journalDraft",
    revertible: "always",
  },
  "expense.categorize": {
    type: "expense.categorize",
    endpoint: "/api/ledger/expenses",
    method: "POST",
    label: "ثبت و دسته‌بندی هزینه",
    payloadHint:
      "{ accountId: string /* حساب هزینه، کد ۵۲۰۰-۵۹۰۰ */, paymentAccountId: string /* حساب پرداخت: صندوق یا بانک */, amount: number, expenseDate?: string, vendor?: string, memo: string }",
    autopilotCategory: "money",
    executor: "expense",
    // reverseEntry only accepts source_type 'manual', which an expense's entry
    // is not — so there is no honest one-click undo. This is why the money
    // category ships with the tightest default caps of the five.
    revertible: false,
  },

  // -- Phase 32 --------------------------------------------------------------
  "inventory.waste.log": {
    type: "inventory.waste.log",
    endpoint: "/api/inventory/waste",
    method: "POST",
    label: "ثبت ضایعات کالا",
    payloadHint:
      '{ inventoryItemId: string, quantity: string /* مقدار به‌صورت رشته، در واحد انبار */, reason: "spoilage"|"prep_error"|"customer_return"|"staff_meal"|"other", note?: string }',
    autopilotCategory: "waste",
    executor: "wasteLog",
    coworkerOnly: true,
    // Waste consumes real FIFO/weighted-average layers at their own cost;
    // "undoing" it would be a receipt at a cost nobody paid, so there is no
    // honest one-click undo. Correct a mistaken write-off with a stock count.
    revertible: false,
  },
  "inventory.production.run": {
    type: "inventory.production.run",
    endpoint: "/api/inventory/production/runs",
    method: "POST",
    label: "ثبت تولید داخلی",
    payloadHint:
      "{ formulaId: string, batches: string /* تعداد بچ به‌صورت رشته */, outputQuantity?: string /* مقدار واقعی تولیدشده */, note?: string }",
    autopilotCategory: "inventory",
    executor: "productionRun",
    // Phase 29 gives a run a real reversal (refused once the batch has sold),
    // which is exactly what a one-click undo needs.
    revertible: "always",
  },
  "menu.item.create": {
    type: "menu.item.create",
    endpoint: "/api/menu/items",
    method: "POST",
    label: "افزودن آیتم جدید به منو",
    payloadHint:
      "{ categoryId: string, name: string, price: number /* ریال صحیح */, description?: string, sku?: string }",
    // Deliberately no autopilotCategory: adding something a customer can order
    // is a product decision, not a bookkeeping one. It is chat-and-confirm
    // ("یک آیتم جدید به منو اضافه کن") forever, whatever an owner switches on.
  },
};

/** A single mutation the agent wants to run, pending the user's "Apply". */
export interface ProposedAction {
  type: ActionType;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
}

export function isKnownAction(type: unknown): type is ActionType {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(ACTION_CATALOG, type);
}

/**
 * Substitutes `{paramName}` placeholders in an action's endpoint from its own
 * proposed payload (e.g. `orderId` for `/api/orders/{orderId}`). Returns null
 * if a placeholder's value is missing, so the caller can refuse to fetch a
 * URL like `/api/orders/undefined` instead of hitting a confusing 404.
 */
export function resolveActionEndpoint(meta: ActionMeta, payload: Record<string, unknown>): string | null {
  let missing = false;
  const resolved = meta.endpoint.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = payload[key];
    if (typeof value !== "string" && typeof value !== "number") {
      missing = true;
      return "";
    }
    return encodeURIComponent(String(value));
  });
  return missing ? null : resolved;
}

export const ACTION_TYPES = Object.keys(ACTION_CATALOG) as ActionType[];

// ---------------------------------------------------------------------------
// Chat message shapes + prompts + tool definitions
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** present on tool-result messages */
  tool_call_id?: string;
}

export type AgentMode = "wizard" | "dashboard" | "floor" | "platform" | "proactive" | "autopilot";

export interface PromptContext {
  mode: AgentMode;
  businessName?: string | null;
  currencyDisplay?: "toman" | "rial";
  /** current wizard step id, when mode === "wizard" */
  currentStep?: string | null;
  userName?: string;
  role?: string;
  /** Wave 5 (issue #145) — a receipt/invoice image is attached to this turn. */
  hasAttachment?: boolean;
  /** Phase 31 — the single category an autopilot run is scoped to. */
  autopilotCategory?: AutopilotCategory;
  /** Phase 31 — narrows the catalogue block to just this run's own actions. */
  allowedActionTypes?: ActionType[];
}

const WIZARD_STEP_LABELS: Record<string, string> = {
  business: "اطلاعات کسب‌وکار",
  accounts: "سرفصل حساب‌ها",
  costing: "روش قیمت‌گذاری موجودی",
  tax: "تنظیم مالیات",
  users: "نقش‌ها و کاربران",
  menu: "ورود منو",
  hardware: "اتصال سخت‌افزار",
  opening: "مانده‌های افتتاحیه",
};

/** The system prompt. Persian-first, grounded, and explicit about the confirm loop. */
export function buildSystemPrompt(ctx: PromptContext): string {
  const lines: string[] = [
    "تو «دستیار هوشمند» یک نرم‌افزار صندوق فروش (POS) کافه و رستوران فارسی‌زبان هستی.",
    "همیشه به زبان فارسی، کوتاه، دقیق و محترمانه پاسخ بده. مبالغ را به تومان و تاریخ‌ها را شمسی در نظر بگیر (ذخیره‌سازی داخلی ریال و میلادی است).",
    "هرگز عدد یا آمار از خودت نساز؛ در حالت‌های دارای ابزار فقط از ابزارهای خواندنِ مجاز و در حالت گزارش زمان‌بندی‌شده فقط از دادهٔ واقعیِ ورودی استفاده کن.",
  ];

  if (ctx.businessName) lines.push(`نام کسب‌وکار: ${ctx.businessName}.`);
  if (ctx.userName) lines.push(`کاربر: ${ctx.userName}${ctx.role ? ` (${ctx.role})` : ""}.`);

  if (ctx.mode === "wizard") {
    const step = ctx.currentStep ? WIZARD_STEP_LABELS[ctx.currentStep] ?? ctx.currentStep : null;
    lines.push(
      "وظیفهٔ اصلی تو در این حالت: کمک به تکمیل «راه‌اندازی اولیه» گام‌به‌گام. با گفت‌وگو اطلاعات هر مرحله را از کاربر بگیر و سپس یک propose_action برای همان مرحله بساز تا فیلدها کامل ثبت شوند.",
      step ? `کاربر اکنون روی مرحلهٔ «${step}» است؛ روی همین مرحله تمرکز کن اما می‌توانی مراحل بعدی را هم پیشنهاد دهی.` : "",
      "برای مرحلهٔ حساب‌ها، قالب پیش‌فرض سرفصل‌ها معمولاً بهترین انتخاب است؛ آن را دست‌نخورده پیشنهاد بده مگر کاربر تغییری بخواهد.",
      "برای هر تغییر در داده‌ها هرگز مستقیم اقدام نکن؛ فقط ابزار propose_action را با نوع مجاز و payload کامل صدا بزن. کاربر خودش با دکمهٔ تأیید آن را اجرا می‌کند (human-in-the-loop).",
      "قبل از پیشنهاد، اطلاعات لازم را با پرسیدن سؤال از کاربر کامل کن؛ فیلدها را با حدس‌های نامطمئن پر نکن.",
    );
  } else if (ctx.mode === "dashboard") {
    lines.push(
      "در این حالت به کاربر (مالک/مدیر) کمک می‌کنی: نمایش و تحلیل گزارش‌ها (فروش، منو، موجودی، حسابداری)، پاسخ به سؤال دربارهٔ وضعیت راه‌اندازی، و انجام کارهای مجاز از طریق پیشنهادِ قابل‌تأیید.",
      "برای گزارش‌ها اول list_reports را صدا بزن تا کلیدهای معتبر را بدانی، سپس run_report را با key و در صورت نیاز بازهٔ تاریخ اجرا کن و خلاصهٔ خوانا بده.",
      "علاوه بر گزارش‌های استاندارد، ابزارهای تخصصی هم داری: عملکرد منو و آیتم‌های باطل‌شده (get_menu_performance، get_void_pattern)، موجودی و تأمین‌کنندگان (get_stock_valuation، get_supplier_performance)، رزرو و میز (get_reservation_conflicts، get_table_turnover_rate)، پیک تحویل (get_courier_performance)، مشتریان (get_customer_profile، get_at_risk_customers)، حسابداری (get_ar_aging، get_ap_upcoming، get_unreconciled_bank_lines، get_payroll_summary، get_vat_liability)، مقایسهٔ شعبه‌ها (get_branch_comparison)، تخمین تقاضا (forecast_demand)، اقلام در حال انقضا (get_near_expiry_items)، پورسانت کارکنان (get_staff_commission) و مشتریان آمادهٔ خرید مجدد (get_repurchase_candidates). هر کدام مناسب سؤال بود همان را صدا بزن؛ برای forecast_demand همیشه در پاسخ صریح بگو که یک تخمین است.",
      "برای سؤال‌هایی مثل «حساب‌هایم را بررسی کن»، «اشتباهی هست؟» یا «چه چیزی جا افتاده؟» حتماً run_accounting_review را صدا بزن و دقیقاً همان یافته‌ها را با درجهٔ اهمیت و پیشنهاد اصلاحشان گزارش کن. هرگز از خودت مورد اضافه نکن و هرگز نگو حسابی مشکل دارد مگر این ابزار گفته باشد.",
      "کاربر می‌تواند کارهای تکرارشونده را به «همکار هوشمند» بسپارد (مثلاً «هر شب با بستن شیفت، ماندهٔ نان را ضایعات بزن» یا «هر روز صبح حساب‌ها را بررسی کن»). با list_coworker_jobs می‌توانی کارهای فعلی و تعداد اجراهای منتظر تأیید را ببینی؛ برای ساختن کار جدید کاربر را به بخش «همکار هوشمند» در صفحهٔ هوش مصنوعی راهنمایی کن.",
      "برای هر تغییر در داده‌ها هرگز مستقیم اقدام نکن؛ فقط ابزار propose_action را با نوع مجاز و payload کامل صدا بزن. کاربر خودش با دکمهٔ تأیید آن را اجرا می‌کند (human-in-the-loop).",
      "قبل از پیشنهاد، اطلاعات لازم را با پرسیدن سؤال از کاربر کامل کن؛ فیلدها را با حدس‌های نامطمئن پر نکن.",
      ctx.hasAttachment
        ? "کاربر در همین پیام یک تصویر فاکتور/رسید پیوست کرده است. اول ابزار draft_expense_from_receipt را صدا بزن تا اطلاعات ساختاریافته از تصویر استخراج شود؛ سپس اگر مبلغ و حساب هزینهٔ مناسب مشخص بود، propose_action از نوع expense.categorize را با همان مقادیر بساز، وگرنه از کاربر مقدار ناقص را بپرس."
        : "",
    );
  } else if (ctx.mode === "floor") {
    lines.push(
      "این حالت فقط برای صندوق‌دار و گارسونِ شعبهٔ فعال است. فقط به سؤال‌های منو، مواد اولیهٔ ثبت‌شده و پیش‌نمایش تقسیم صورت‌حساب همان شعبه پاسخ بده.",
      "هیچ تغییری ثبت نکن و امکان پیشنهادِ اجرایی نداری. فقط راهنمایی کن؛ اجرای تقسیم صورت‌حساب یا هر عملیات دیگر باید از جریان عادی POS انجام شود.",
      "در پرسش‌های حساسیت/آلرژی، فقط دادهٔ ثبت‌شده را بازگو کن. اگر ابزار گفت دادهٔ ساخت‌یافتهٔ آلرژن موجود نیست، صریح بگو که ایمن‌بودن غذا قابل تأیید نیست و باید با آشپزخانه بررسی شود؛ هرگز از روی نام مواد حدس نزن.",
      "برای صورت‌حساب فقط از get_bill_split_preview استفاده کن و هرگز شمارهٔ تلفن، نام مهمان یا دادهٔ مشتری را بازگو نکن.",
    );
  } else if (ctx.mode === "autopilot") {
    lines.push(
      "این یک اجرای زمان‌بندی‌شده و بدون حضور کاربر است؛ هیچ‌کس در لحظه پاسخ تو را نمی‌خواند و نمی‌تواند سؤال تو را جواب دهد.",
      "فقط در محدودهٔ همین دسته کار کن و حداکثر یک propose_action بساز. اگر چند قلم را می‌توان در یک payload جمع کرد، در همان یک پیشنهاد بیاور.",
      "اگر داده‌ها اقدامی را به‌روشنی توجیه نمی‌کنند، هیچ پیشنهادی نساز و فقط با متن کوتاه بگو چیزی برای انجام نیست. پیشنهادِ نامطمئن بدتر از نبودِ پیشنهاد است.",
      "فیلدها را با حدس پر نکن؛ هر مقدار باید از دادهٔ واقعیِ ابزارها آمده باشد.",
      "هر پیشنهادی که از سقف تعیین‌شدهٔ کسب‌وکار بگذرد، اجرا نمی‌شود و برای تأیید انسانی کنار گذاشته می‌شود؛ پس بزرگ‌نمایی هیچ سودی ندارد.",
      "هرگز ادعا نکن که پیامی برای مشتری ارسال شده است؛ در این حالت هیچ کانال ارسالی وجود ندارد.",
    );
  } else if (ctx.mode === "proactive") {
    lines.push(
      "این حالت فقط برای گزارش خصوصیِ زمان‌بندی‌شدهٔ همان کسب‌وکار است. داده‌های واقعی در پیام کاربر آمده‌اند و هیچ ابزار، هیچ پیشنهاد اجرایی و هیچ کانال ارسالی نداری.",
      "فقط بر اساس همان داده‌ها یک متن فارسی کوتاه و عملیاتی بنویس. اگر داده‌ای ناقص است آن را صریح بگو؛ هرگز عدد، موعد قانونی، تغییر ثبت‌شده یا پیامِ ارسال‌شده جعل نکن.",
      "هرگز پیام مشتری، شماره تماس، دستور API یا propose_action تولید نکن. خروجی صرفاً برای بررسی انسانی داخل نرم‌افزار است.",
    );
  } else {
    lines.push(
      "این حالت مخصوص تیم پشتیبانی پلتفرم است، نه یک کسب‌وکار. فقط وضعیت سلامت سراسریِ مجاز را بررسی کن: وضعیت نسخهٔ نصب‌های مشتری و سلامت پشتیبان‌گیری.",
      "به دادهٔ عملیاتی یا شخصی هیچ کسب‌وکاری دسترسی نداری و امکان پیشنهاد یا ثبت تغییر نداری. اگر سؤال خارج از ابزارهای مجاز بود، شفاف بگو که این دستیار فقط برای سلامت سکو طراحی شده است.",
    );
  }

  if (ctx.mode === "wizard" || ctx.mode === "dashboard" || ctx.mode === "autopilot") {
    // An autopilot run sees only its own category's actions, so the model is
    // never told about a tool this run is not allowed to call.
    const types = ctx.mode === "autopilot" ? ctx.allowedActionTypes ?? [] : ACTION_TYPES;
    const catalog = types
      .map((t) => `- ${t}: ${ACTION_CATALOG[t].label} — payload: ${ACTION_CATALOG[t].payloadHint}`)
      .join("\n");
    lines.push("انواع عملیات مجاز برای propose_action و ساختار payload آن‌ها:\n" + catalog);
  }

  return lines.filter(Boolean).join("\n");
}

export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** A date-range tool with only optional dateFrom/dateTo params. */
function dateRangeTool(name: string, description: string, extraProps: Record<string, unknown> = {}): OpenAiTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          dateFrom: { type: "string", description: "از تاریخ (ISO)، اختیاری" },
          dateTo: { type: "string", description: "تا تاریخ (ISO)، اختیاری" },
          ...extraProps,
        },
        additionalProperties: false,
      },
    },
  };
}

function noArgsTool(name: string, description: string): OpenAiTool {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties: {}, additionalProperties: false } },
  };
}

export interface ToolDefinitionsOptions {
  /** Wave 5 (issue #145) — only offer draft_expense_from_receipt when a turn actually attached an image. */
  hasAttachment?: boolean;
  /**
   * Phase 31 — narrows propose_action's `type` enum to this run's own
   * category. Ignored outside autopilot mode, where the full catalogue applies.
   */
  actionTypes?: ActionType[];
}

/** OpenAI-compatible tool list. Read tools run server-side; propose_action is the confirm gate. */
export function toolDefinitions(mode: AgentMode, opts: ToolDefinitionsOptions = {}): OpenAiTool[] {
  const readTools: OpenAiTool[] = [
    {
      type: "function",
      function: {
        name: "get_setup_state",
        description:
          "وضعیت کامل راه‌اندازی کسب‌وکار: نام، شعبه، تنظیمات، شمارش حساب‌ها/کاربران/دسته‌ها/اقلام و مراحل ناتمام. پارامتر ندارد.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "list_reports",
        description: "فهرست گزارش‌های استاندارد در دسترس (key و عنوان). پارامتر ندارد.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "run_report",
        description:
          "اجرای یک گزارش استاندارد و برگرداندن ردیف‌های خلاصه. key را حتماً از list_reports بگیر. تاریخ‌ها میلادی ISO (YYYY-MM-DD).",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "کلید گزارش استاندارد" },
            dateFrom: { type: "string", description: "از تاریخ (ISO)، اختیاری" },
            dateTo: { type: "string", description: "تا تاریخ (ISO)، اختیاری" },
          },
          required: ["key"],
          additionalProperties: false,
        },
      },
    },
    // Phase 18b Wave 1 — read-only tools across every module. Dashboard mode only
    // (the wizard agent stays scoped to setup state), see READ_TOOL_NAMES in ai-tools.ts.
    dateRangeTool(
      "get_menu_performance",
      "بهترین و بدترین اقلام منو از نظر فروش، و اقلامی که هرگز سفارش داده نشده‌اند (بازه پیش‌فرض: ۳۰ روز اخیر).",
    ),
    dateRangeTool(
      "get_void_pattern",
      "الگوی آیتم‌های باطل‌شده: بر اساس نوع آیتم، کارمند بازکننده سفارش، و ساعت روز (بازه پیش‌فرض: ۳۰ روز اخیر).",
    ),
    noArgsTool("get_stock_valuation", "ارزش‌گذاری فعلی موجودی انبار برای هر کالا و مجموع کل."),
    dateRangeTool(
      "get_supplier_performance",
      "عملکرد تأمین‌کنندگان: تعداد خرید، مجموع مبلغ، و میانگین زمان تحویل (بازه پیش‌فرض: ۹۰ روز اخیر).",
    ),
    noArgsTool("get_reservation_conflicts", "رزروهای فعال آینده که روی یک میز با هم تداخل زمانی دارند."),
    dateRangeTool(
      "get_table_turnover_rate",
      "میانگین مدت اشغال و درآمد هر میز بر اساس نشست‌های بسته‌شده (بازه پیش‌فرض: ۳۰ روز اخیر).",
    ),
    dateRangeTool(
      "get_courier_performance",
      "عملکرد پیک‌ها: تعداد تحویل، درآمد، هزینه پیک، و میانگین زمان تحویل (بازه پیش‌فرض: ۳۰ روز اخیر).",
    ),
    {
      type: "function",
      function: {
        name: "get_customer_profile",
        description: "پروفایل یک مشتری مشخص: اطلاعات تماس، تعداد و مجموع سفارش‌ها، اولین/آخرین خرید.",
        parameters: {
          type: "object",
          properties: { customerId: { type: "string", description: "شناسه مشتری" } },
          required: ["customerId"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_at_risk_customers",
        description: "مشتریان وفادار (حداقل چند سفارش) که مدتی است خرید نکرده‌اند.",
        parameters: {
          type: "object",
          properties: {
            minOrders: { type: "number", description: "حداقل تعداد سفارش تاریخی، پیش‌فرض ۳" },
            lapsedDays: { type: "number", description: "چند روز از آخرین خرید گذشته باشد، پیش‌فرض ۳۰" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_ar_aging",
        description: "سنی حساب‌های دریافتنی (طلب از مشتریان) به تفکیک مشتری، در بازه‌های جاری/۳۰/۶۰/۹۰+ روز.",
        parameters: {
          type: "object",
          properties: { asOfDate: { type: "string", description: "تاریخ مبنا (ISO)، پیش‌فرض امروز" } },
          additionalProperties: false,
        },
      },
    },
    noArgsTool(
      "get_ap_upcoming",
      "فاکتورهای باز به تأمین‌کنندگان (بدون تاریخ سررسید ثبت‌شده)، مرتب‌شده بر اساس قدمت برای اولویت پرداخت.",
    ),
    noArgsTool("get_unreconciled_bank_lines", "ردیف‌های دفتر (نقد و بانک در جریان) که هنوز در هیچ مغایرت‌گیری تطبیق نشده‌اند."),
    noArgsTool("get_payroll_summary", "خلاصه اجراهای اخیر حقوق و دستمزد و مجموع حقوق ماهانه کارکنان فعال."),
    dateRangeTool("get_vat_liability", "مالیات بر ارزش افزوده فروش در برابر خرید و وضعیت بدهی خالص برای یک بازه."),
    dateRangeTool(
      "get_branch_comparison",
      "مقایسه شعبه‌های همین کسب‌وکار: تعداد سفارش، درآمد، و برآورد هزینه نیروی انسانی (بازه پیش‌فرض: ۳۰ روز اخیر).",
    ),
    {
      type: "function",
      function: {
        name: "forecast_demand",
        description:
          "تخمین ساده فروش/تقاضای آینده بر اساس میانگین ۲۸ روز گذشته — همیشه یک برآورد است، نه پیش‌بینی قطعی.",
        parameters: {
          type: "object",
          properties: {
            menuItemId: { type: "string", description: "برای تخمین یک آیتم منو مشخص، اختیاری" },
            horizonDays: { type: "number", description: "تعداد روزهای آینده، پیش‌فرض ۷، حداکثر ۳۰" },
          },
          additionalProperties: false,
        },
      },
    },
    noArgsTool(
      "get_near_expiry_items",
      "بچ‌های اقلام آرایشی/بهداشتی با تاریخ انقضای نزدیک (فقط کسب‌وکارهای آرایشی و بهداشتی).",
    ),
    dateRangeTool(
      "get_staff_commission",
      "گزارش پورسانت فروش کارکنان: مبلغ تعلق‌گرفته به تفکیک کارمند (بازه پیش‌فرض: ماه جاری).",
    ),
    noArgsTool(
      "get_repurchase_candidates",
      "مشتریانی که طبق فاصلهٔ خرید ثبت‌شده، وقت خرید مجددشان رسیده است (وفاداری).",
    ),
    // Phase 32 — the coworker's own two. Both are deterministic checks over the
    // database, not model judgement; the assistant explains what they found.
    {
      type: "function",
      function: {
        name: "run_accounting_review",
        description:
          "بازبینی کامل دفترها و پیدا کردن اشکال‌های واقعی: سند نامتوازن، رویداد انباری ثبت‌نشده در دفتر، فروش تسویه‌شدهٔ بدون سند، سرفصل جاافتاده، پیش‌نویس معطل، کسری/اضافهٔ صندوق، چک سررسیدگذشته، طلب معوق، موجودی منفی و دورهٔ مالی بسته‌نشده. هر مورد با درجهٔ اهمیت، مبلغ و پیشنهاد اصلاح برمی‌گردد. این ابزار یک بررسی قطعی روی داده است، نه تحلیل حدسی — نتیجهٔ آن را همان‌طور که هست گزارش کن و موردی به آن اضافه نکن.",
        parameters: {
          type: "object",
          properties: {
            asOfDate: { type: "string", description: "تاریخ مبنا (ISO)، پیش‌فرض امروز" },
          },
          additionalProperties: false,
        },
      },
    },
    noArgsTool(
      "list_coworker_jobs",
      "فهرست کارهای تعریف‌شدهٔ «همکار هوشمند» این کسب‌وکار (قالب، زمان اجرا، حالت تأیید، آخرین اجرا) و تعداد اجراهای منتظر تأیید. پارامتر ندارد.",
    ),
  ];

  // Wave 5 (issue #145) — only meaningful when the client actually attached a
  // receipt/invoice image to this turn; the extraction itself runs as an
  // isolated provider call (see extractReceiptDraft in ai-service.ts), never
  // by resending the image on every later tool round.
  const receiptTool: OpenAiTool = {
    type: "function",
    function: {
      name: "draft_expense_from_receipt",
      description:
        "استخراج اطلاعات ساختاریافته (فروشنده، تاریخ، مبلغ، حساب هزینهٔ پیشنهادی) از تصویر فاکتور/رسیدِ پیوست‌شده در همین پیام. فقط زمانی در دسترس است که کاربر تصویری پیوست کرده باشد. نتیجه فقط یک استخراج خودکار است؛ برای ثبت باید propose_action از نوع expense.categorize با مقادیر بررسی‌شده ساخته شود.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "راهنمایی یا زمینهٔ اضافه دربارهٔ این هزینه، اختیاری" },
        },
        additionalProperties: false,
      },
    },
  };

  const proposeToolFor = (types: ActionType[]): OpenAiTool => ({
    type: "function",
    function: {
      name: "propose_action",
      description:
        "پیشنهاد یک تغییر برای تأیید کاربر. هیچ تغییری بدون تأیید انسان اجرا نمی‌شود. type باید یکی از انواع مجاز باشد و payload دقیقاً مطابق ساختار همان نوع.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: types, description: "نوع عملیات مجاز" },
          title: { type: "string", description: "عنوان کوتاه فارسی برای کارت تأیید" },
          summary: { type: "string", description: "توضیح خوانا از آنچه اجرا می‌شود و مقادیر کلیدی" },
          payload: { type: "object", description: "بدنهٔ درخواست مطابق ساختار همان نوع عملیات" },
        },
        required: ["type", "title", "summary", "payload"],
        additionalProperties: false,
      },
    },
  });
  const proposeTool = proposeToolFor(ACTION_TYPES);

  const floorReadTools: OpenAiTool[] = [
    {
      type: "function",
      function: {
        name: "get_menu_item_details",
        description:
          "جست‌وجوی آیتم منوی شعبهٔ فعال، توضیح و مواد اولیهٔ ثبت‌شدهٔ آن. برای پرسش آلرژی فقط وضعیت دادهٔ ثبت‌شده را برمی‌گرداند و هیچ آلرژنی را حدس نمی‌زند.",
        parameters: {
          type: "object",
          properties: {
            menuItemId: { type: "string", description: "شناسهٔ آیتم منو، اختیاری اگر نام/عبارت جست‌وجو داده شود" },
            query: { type: "string", description: "نام یا بخشی از نام آیتم منو" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_bill_split_preview",
        description:
          "پیش‌نمایش فقط‌خواندنیِ تقسیم برابر صورت‌حساب یک میز باز در شعبهٔ فعال؛ هیچ پرداخت یا تقسیمی ثبت نمی‌کند.",
        parameters: {
          type: "object",
          properties: {
            tableSessionId: { type: "string", description: "شناسهٔ نشست میز باز، اختیاری اگر نام میز داده شود" },
            tableName: { type: "string", description: "نام میز، مانند «میز ۳»" },
            guests: { type: "number", description: "تعداد مهمان‌ها، بین ۱ تا ۵۰" },
          },
          required: ["guests"],
          additionalProperties: false,
        },
      },
    },
  ];

  const platformReadTools: OpenAiTool[] = [
    noArgsTool(
      "get_client_update_status",
      "وضعیت نسخهٔ نصب‌های متصل: کسب‌وکارهایی که نسخهٔ قدیمی دارند یا گزارش نسخه‌شان خطا دارد.",
    ),
    {
      type: "function",
      function: {
        name: "get_backup_health",
        description: "وضعیت آخرین پشتیبان‌گیری هر کسب‌وکار و اجراهای ناموفق در بازهٔ زمانی مشخص.",
        parameters: {
          type: "object",
          properties: {
            lookbackHours: { type: "number", description: "بازهٔ بررسی خطا بر حسب ساعت، پیش‌فرض ۲۴ و حداکثر ۱۶۸" },
          },
          additionalProperties: false,
        },
      },
    },
  ];

  if (mode === "wizard") return [readTools[0], proposeTool];
  if (mode === "dashboard") {
    return opts.hasAttachment ? [...readTools, receiptTool, proposeTool] : [...readTools, proposeTool];
  }
  if (mode === "floor") return floorReadTools;
  if (mode === "proactive") return [];
  if (mode === "autopilot") {
    // Zero read tools, exactly like proactive mode: the service collects a
    // bounded, category-scoped fact set server-side and puts it in the prompt.
    // That keeps an unattended run to a single provider round (one credit
    // reservation, no six-round tool loop) and means the model can only ever
    // act on facts this codebase gathered, not on a query it composed itself.
    const types = opts.actionTypes ?? [];
    return types.length === 0 ? [] : [proposeToolFor(types)];
  }
  return platformReadTools;
}
