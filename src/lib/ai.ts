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
  | "setup.menu.item";

export interface ActionMeta {
  type: ActionType;
  endpoint: string;
  method: "POST";
  /** Persian label shown on the confirm card. */
  label: string;
  /** Which wizard step this completes, if any (drives "advance" after apply). */
  wizardStep?: string;
  /** Human-readable description of the expected payload, injected into the prompt. */
  payloadHint: string;
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

export type AgentMode = "wizard" | "dashboard";

export interface PromptContext {
  mode: AgentMode;
  businessName?: string | null;
  currencyDisplay?: "toman" | "rial";
  /** current wizard step id, when mode === "wizard" */
  currentStep?: string | null;
  userName?: string;
  role?: string;
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
    "هرگز عدد یا آمار از خودت نساز؛ برای هر داده‌ای اول ابزارهای خواندن (get_setup_state, list_reports, run_report) را صدا بزن و بر اساس نتیجهٔ واقعی پاسخ بده.",
    "برای هر تغییری در داده‌ها (پر کردن ویزارد، افزودن آیتم منو، تنظیم مالیات و…) هرگز مستقیم اقدام نکن؛ فقط ابزار propose_action را با نوع مجاز و payload کامل صدا بزن. کاربر خودش با دکمهٔ تأیید آن را اجرا می‌کند (human-in-the-loop).",
    "قبل از پیشنهاد، اطلاعات لازم را با پرسیدن سؤال از کاربر کامل کن؛ فیلدها را با حدس‌های نامطمئن پر نکن.",
  ];

  if (ctx.businessName) lines.push(`نام کسب‌وکار: ${ctx.businessName}.`);
  if (ctx.userName) lines.push(`کاربر: ${ctx.userName}${ctx.role ? ` (${ctx.role})` : ""}.`);

  if (ctx.mode === "wizard") {
    const step = ctx.currentStep ? WIZARD_STEP_LABELS[ctx.currentStep] ?? ctx.currentStep : null;
    lines.push(
      "وظیفهٔ اصلی تو در این حالت: کمک به تکمیل «راه‌اندازی اولیه» گام‌به‌گام. با گفت‌وگو اطلاعات هر مرحله را از کاربر بگیر و سپس یک propose_action برای همان مرحله بساز تا فیلدها کامل ثبت شوند.",
      step ? `کاربر اکنون روی مرحلهٔ «${step}» است؛ روی همین مرحله تمرکز کن اما می‌توانی مراحل بعدی را هم پیشنهاد دهی.` : "",
      "برای مرحلهٔ حساب‌ها، قالب پیش‌فرض سرفصل‌ها معمولاً بهترین انتخاب است؛ آن را دست‌نخورده پیشنهاد بده مگر کاربر تغییری بخواهد.",
    );
  } else {
    lines.push(
      "در این حالت به کاربر (مالک/مدیر) کمک می‌کنی: نمایش و تحلیل گزارش‌ها (فروش، منو، موجودی، حسابداری)، پاسخ به سؤال دربارهٔ وضعیت راه‌اندازی، و انجام کارهای مجاز از طریق پیشنهادِ قابل‌تأیید.",
      "برای گزارش‌ها اول list_reports را صدا بزن تا کلیدهای معتبر را بدانی، سپس run_report را با key و در صورت نیاز بازهٔ تاریخ اجرا کن و خلاصهٔ خوانا بده.",
    );
  }

  const catalog = ACTION_TYPES.map((t) => `- ${t}: ${ACTION_CATALOG[t].label} — payload: ${ACTION_CATALOG[t].payloadHint}`).join(
    "\n",
  );
  lines.push("انواع عملیات مجاز برای propose_action و ساختار payload آن‌ها:\n" + catalog);

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

/** OpenAI-compatible tool list. Read tools run server-side; propose_action is the confirm gate. */
export function toolDefinitions(mode: AgentMode): OpenAiTool[] {
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
  ];

  const proposeTool: OpenAiTool = {
    type: "function",
    function: {
      name: "propose_action",
      description:
        "پیشنهاد یک تغییر برای تأیید کاربر. هیچ تغییری بدون تأیید انسان اجرا نمی‌شود. type باید یکی از انواع مجاز باشد و payload دقیقاً مطابق ساختار همان نوع.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ACTION_TYPES, description: "نوع عملیات مجاز" },
          title: { type: "string", description: "عنوان کوتاه فارسی برای کارت تأیید" },
          summary: { type: "string", description: "توضیح خوانا از آنچه اجرا می‌شود و مقادیر کلیدی" },
          payload: { type: "object", description: "بدنهٔ درخواست مطابق ساختار همان نوع عملیات" },
        },
        required: ["type", "title", "summary", "payload"],
        additionalProperties: false,
      },
    },
  };

  // Read tools are useful in both modes (the wizard agent inspects setup state too).
  return mode === "wizard" ? [readTools[0], proposeTool] : [...readTools, proposeTool];
}
