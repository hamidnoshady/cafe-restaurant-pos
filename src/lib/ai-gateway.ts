/**
 * Phase 37 & Phase 39 — the gateway half of the AI connection, kept free of the network,
 * the database and `next/*`.
 *
 * A gateway (LiteLLM) fronts many upstream vendors behind one OpenAI-shaped
 * endpoint, so the provider client in ai-service.ts never needs to learn that
 * one exists. What it *does* need is a handful of decisions made before the
 * request goes out — which credential to send, which model alias to ask for,
 * whether to attach a failover chain — and every one of those is a pure
 * function of configuration, so they live here where they can be tested
 * without a proxy, a socket or a Postgres (see ai-gateway.test.ts).
 *
 * Phase 39 introduces branch-level overrides:
 * Model resolution: branch override -> business override -> gateway alias -> platform default.
 * Virtual key resolution: branch key -> business key -> gateway master key -> none.
 *
 * Single-architecture rule (migration 0168): the proxy owns routing, model
 * limits, RPM/TPM and provider management. This console mirrors NONE of that —
 * a stored copy of a proxy-side setting is a second source of truth that
 * silently disagrees with the proxy, and the request path must never depend
 * on it. The platform owns only what the proxy cannot know: the tenant credit
 * (wallet), the USD→Rial pricing read-back and the plan-included allowance.
 */

import type { AiConfig } from "./ai";

export interface AiGatewayConfig {
  enabled: boolean;
  baseUrl: string;
  /** The proxy admin key. Server-side only — never serialised to a client. */
  masterKey: string;
  /** Gateway model alias for chat; empty means "use the platform model". */
  chatModel: string;
  /** Gateway model alias for embeddings; empty means "use the chat model". */
  embeddingModel: string;
  /** Failover chain, tried in order after the primary model errors. */
  fallbackModels: string[];
  /** Mint and use one virtual key per business or branch. */
  virtualKeysEnabled: boolean;
  /** Whether a business owner may choose a model, and from which list. */
  allowBusinessModels: boolean;
  publishedModels: string[];
  /** Phase 38b — FX rate turning the gateway's USD cost figures into Rial. */
  usdRialRate: number | null;
  /** Phase 38b — settle turns on the gateway's own reported cost. */
  gatewayCostingEnabled: boolean;
  /** Manual fallback rates used only when gateway costing is disabled. */
  inputCostRialPerMillion: number;
  outputCostRialPerMillion: number;
  /**
   * Optional extra margin the platform adds on top of LiteLLM's reported cost,
   * in percent. Normally 0: cost-plus-margin pricing is configured inside
   * LiteLLM itself, and the platform only converts and decrements. Kept here
   * so an operator can still add a platform-side markup without touching the
   * gateway config.
   */
  revenueMarginPercent: number;
  /**
   * The Rial ceiling reserved from a business's credit for one assistant turn,
   * released back down to LiteLLM's actual reported cost at settlement.
   */
  maxTurnRial: number;
  /** Phase 38b — whether the proxy may front MCP servers at all. */
  mcpEnabled: boolean;
  /** Phase 38b — the MCP servers the proxy may front (agentic tools). */
  mcpServers: GatewayMcpServer[];
}

/**
 * What one assistant turn cost, resolved from the gateway's own reported figure.
 *
 * `resolveGatewayTurnPricing` (ai-gateway-service.ts) reads LiteLLM's
 * `x-litellm-response-cost` header, converts the USD figure to Rial with the
 * operator's FX rate, and applies any platform margin, producing this shape;
 * `settleAiTurn` (ai-wallet-billing.ts) then decrements the wallet by
 * `chargedRial`.
 *
 * Phase J relocated this type here from the now-deleted `ai-billing-service.ts`.
 * It is a pure pricing shape (no money side effects, no schema), so it belongs
 * with the gateway's other framework-free config types rather than with the
 * legacy billing service that once also owned the credit ledger.
 */
export interface AiGatewayTurnPricing {
  costUsd: number;
  costRial: number;
  chargedRial: number;
}

/**
 * Gateway config with the master key replaced by a boolean.
 *
 * Only the master key is a bearer credential and stays server-side; the costing
 * fields (conversion rate, margin, ceilings) are operator settings the LiteLLM
 * console must show and edit.
 */
export interface PublicAiGatewayConfig extends Omit<AiGatewayConfig, "masterKey"> {
  hasMasterKey: boolean;
}

export interface AiGatewayInput {
  enabled?: boolean;
  baseUrl?: string;
  masterKey?: string;
  chatModel?: string;
  embeddingModel?: string;
  fallbackModels?: unknown;
  virtualKeysEnabled?: boolean;
  allowBusinessModels?: boolean;
  publishedModels?: unknown;
  usdRialRate?: number | null;
  gatewayCostingEnabled?: boolean;
  inputCostRialPerMillion?: number | null;
  outputCostRialPerMillion?: number | null;
  revenueMarginPercent?: number | null;
  maxTurnRial?: number | null;
  mcpEnabled?: boolean;
  mcpServers?: unknown;
}

/**
 * Phase 38b — one MCP server the LiteLLM proxy fronts.
 */
export interface GatewayMcpServer {
  /** Stable identifier — becomes the proxy's `server_label` and its URL path. */
  name: string;
  /** Persian display name for the console. */
  label: string;
  /** The server's MCP endpoint (streamable HTTP). */
  url: string;
}

/** One business or branch's slice of the gateway: its key and its model choice. */
export interface BusinessGateway {
  id?: string;
  businessId: string;
  locationId: string | null;
  virtualKey: string | null;
  keyAlias: string | null;
  modelOverride: string | null;
  spendUsd: number;
  syncedAt: string | null;
  syncError: string | null;
}

/** Client-safe shape: the virtual key is a bearer credential and stays server-side. */
export interface PublicBusinessGateway extends Omit<BusinessGateway, "virtualKey"> {
  hasVirtualKey: boolean;
  /** Which model this business's calls actually resolve to, gateway included. */
  effectiveModel: string;
}

export interface GatewayProbe {
  ok: boolean;
  /** Wall-clock milliseconds for the liveliness call. */
  latencyMs: number | null;
  /** Model aliases the gateway is serving, when the admin key allowed listing them. */
  models: string[];
  /** A short, human-readable failure reason — Persian, shown verbatim in the console. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Defaults and coercion
// ---------------------------------------------------------------------------

export const DEFAULT_GATEWAY_BASE_URL = "http://litellm:4000/v1";

export function defaultGatewayConfig(): AiGatewayConfig {
  return {
    enabled: false,
    baseUrl: DEFAULT_GATEWAY_BASE_URL,
    masterKey: "",
    chatModel: "",
    embeddingModel: "",
    fallbackModels: [],
    virtualKeysEnabled: false,
    allowBusinessModels: false,
    publishedModels: [],
    usdRialRate: null,
    gatewayCostingEnabled: false,
    inputCostRialPerMillion: 0,
    outputCostRialPerMillion: 0,
    revenueMarginPercent: 0,
    maxTurnRial: 0,
    mcpEnabled: false,
    mcpServers: [],
  };
}

export function emptyBusinessGateway(businessId: string, locationId: string | null = null): BusinessGateway {
  return {
    businessId,
    locationId,
    virtualKey: null,
    keyAlias: null,
    modelOverride: null,
    spendUsd: 0,
    syncedAt: null,
    syncError: null,
  };
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A `jsonb` column arrives as a parsed array; the UI also posts plain strings
 * and comma-separated text. Accept all three so the console never has to know
 * which column produced the value.
 */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => trimmed(entry))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

/** The inverse of `toStringList` for the console textarea. */
export function toListText(values: string[]): string {
  return values.join("\n");
}

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

/** `name | label | url`, one server per line — the console's MCP editor format. */
export function mcpServersToText(servers: GatewayMcpServer[]): string {
  return servers.map((server) => [server.name, server.label, server.url].join(" | ")).join("\n");
}

/**
 * Normalise the MCP server list.
 */
export function normalizeMcpServers(value: unknown): GatewayMcpServer[] {
  if (!Array.isArray(value)) return [];
  const servers: GatewayMcpServer[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = trimmed(row.name).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const url = trimmed(row.url);
    if (!name || !url || seen.has(name)) continue;
    seen.add(name);
    servers.push({ name, label: trimmed(row.label) || name, url });
  }
  return servers;
}

/** Parse the console's `name | label | url` textarea into server rows. */
export function mcpServersFromText(text: string): GatewayMcpServer[] {
  return normalizeMcpServers(
    text
      .split("\n")
      .map((line) => {
        const [name, label, url] = line.split("|");
        return { name, label, url };
      }),
  );
}

/**
 * The `tools` entries that hand the proxy's MCP servers to one call.
 */
export function gatewayMcpToolsBody(gateway: AiGatewayConfig | null): Record<string, unknown> {
  if (!gateway || !gateway.enabled || !gateway.mcpEnabled || gateway.mcpServers.length === 0) {
    return {};
  }
  return {
    tools: gateway.mcpServers.map((server) => ({
      type: "mcp",
      server_url: `litellm_proxy/${server.name}/mcp`,
      server_label: server.name,
      require_approval: "never",
    })),
  };
}

/**
 * LiteLLM's per-response cost header, in USD.
 */
export function parseResponseCostHeader(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/** The gateway's USD figure in integer Rial, rounded once, never negative. */
export function rialFromGatewayUsd(costUsd: number, usdRialRate: number): number {
  const cost = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0;
  const rate = Number.isFinite(usdRialRate) && usdRialRate > 0 ? usdRialRate : 0;
  if (cost <= 0 || rate <= 0) return 0;
  return Math.ceil(cost * rate);
}

/**
 * The settlement figures for one turn priced by the gateway.
 */
export function gatewayTurnPricing(
  costUsd: number,
  usdRialRate: number,
  marginPercent: number,
): { costRial: number; chargedRial: number } {
  const costRial = rialFromGatewayUsd(costUsd, usdRialRate);
  if (costRial <= 0) return { costRial: 0, chargedRial: 0 };
  const margin = Number.isFinite(marginPercent) && marginPercent > 0 ? marginPercent : 0;
  const chargedRial = Math.ceil((costRial * (100 + margin)) / 100);
  return { costRial, chargedRial: Math.max(chargedRial, costRial) };
}

export function toPublicGatewayConfig(config: AiGatewayConfig): PublicAiGatewayConfig {
  const { masterKey, ...rest } = config;
  return { ...rest, hasMasterKey: masterKey.length > 0 };
}

// ---------------------------------------------------------------------------
// Gateway REST endpoints
// ---------------------------------------------------------------------------

export function gatewayManagementUrl(baseUrl: string): string {
  const root = trimmed(baseUrl).replace(/\/+$/, "");
  return root.endsWith("/v1") ? root.slice(0, -3) : root;
}

export function livelinessUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/health/liveliness`;
}

export function modelInfoUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/model/info`;
}

export function keyGenerateUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/generate`;
}

export function keyUpdateUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/update`;
}

export function keyDeleteUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/delete`;
}

export function keyInfoUrl(baseUrl: string, key: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/info?key=${encodeURIComponent(key)}`;
}

// ---------------------------------------------------------------------------
// Parsing gateway responses
// ---------------------------------------------------------------------------

/** `/model/info` returns `{ data: [{ model_name, litellm_params }] }`. */
export function parseGatewayModels(payload: unknown): string[] {
  const row = payload as { data?: unknown } | null;
  const data = row?.data;
  if (!Array.isArray(data)) return [];
  const names = data
    .map((entry) => {
      const item = entry as { model_name?: unknown; id?: unknown };
      if (typeof item.model_name === "string" && item.model_name.trim()) return item.model_name.trim();
      if (typeof item.id === "string" && item.id.trim()) return item.id.trim();
      return "";
    })
    .filter((name) => name.length > 0);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** `/key/generate` answers `{ key: "sk-…", … }`. */
export function parseGeneratedKey(payload: unknown): string | null {
  // LiteLLM has returned both `{key}` and `{token}` over its releases. Some
  // OpenAI-compatible deployments wrap the management response in `data`, so
  // accept that shape too rather than reporting a successful request as a
  // missing key.
  const row = payload as Record<string, unknown> | null;
  if (!row || typeof row !== "object") return null;
  for (const source of [row, row.data as Record<string, unknown> | undefined]) {
    if (!source || typeof source !== "object") continue;
    for (const field of ["key", "token", "api_key"]) {
      const value = source[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/** `/key/info` answers `{ key, info: { spend, max_budget } }`. */
export function parseKeySpend(payload: unknown): {
  spendUsd: number;
  maxBudgetUsd: number | null;
} | null {
  const row = payload as { info?: unknown } | null;
  const source = (row?.info && typeof row.info === "object" ? row.info : row) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!source) return null;
  const spend = Number(source.spend);
  if (!Number.isFinite(spend)) return null;
  const budget = source.max_budget;
  const budgetNumber = typeof budget === "number" ? budget : Number(budget);
  return {
    spendUsd: spend,
    maxBudgetUsd:
      typeof budgetNumber === "number" && Number.isFinite(budgetNumber) && budgetNumber > 0
        ? budgetNumber
        : null,
  };
}

/** Map a management-API status onto a Persian message shown in the console. */
export function gatewayStatusMessage(status: number): string {
  if (status === 401 || status === 403) return "کلید مدیر دروازه پذیرفته نشد.";
  if (status === 404) return "نشانی دروازه یافت نشد (مسیر مدیریت در دسترس نیست).";
  if (status >= 500) return "دروازه در دسترس است اما خطای داخلی داد.";
  return `دروازه پاسخ نامنتظر داد (${status}).`;
}

// ---------------------------------------------------------------------------
// The operator-facing error vocabulary
// ---------------------------------------------------------------------------

/**
 * Persian text for every `ai_gateway_*` code the console can be shown: the
 * codes minted by the gateway calls (`unreachable`, `auth`, …), the ones the
 * service throws when a response cannot be parsed, the validation codes from
 * `validateGatewayInput`/`validateBusinessGatewayInput`, and the pre-flight
 * codes the console route answers before it will even try to mint a key.
 *
 * One table for server and client: the service composes the `sync_error` text
 * stored on a business's row from it, and the console's `errorMessage()`
 * consults it as a fallback so a code never reaches an operator untranslated.
 * A code without an entry here is a bug — `gatewayErrorText` returns
 * `undefined` for it so the console falls back to its generic message rather
 * than showing the raw code.
 */
export const GATEWAY_ERROR_TEXT: Record<string, string> = {
  // Pre-flight: the console route refuses to mint before any network call,
  // because each of these states would produce a key that cannot work (or,
  // for the master key, a call the proxy is guaranteed to refuse).
  ai_gateway_disabled:
    "دروازهٔ هوش مصنوعی فعال نیست. ابتدا آن را در «تنظیمات دروازه» همین صفحه روشن کرده و ذخیره کنید.",
  ai_gateway_missing_master_key:
    "کلید مدیر دروازه ثبت نشده است. آن را در «تنظیمات دروازه» وارد و ذخیره کنید؛ بدون کلید مدیر، دروازه اجازهٔ صدور کلید نمی‌دهد.",
  ai_gateway_virtual_keys_disabled:
    "صدور کلید مجازی در تنظیمات دروازه خاموش است. گزینهٔ «صدور کلید مجازی برای هر کسب‌وکار و شعبه» را روشن کنید تا کلید صادرشده واقعاً به‌کار گرفته شود.",
  // The management calls themselves.
  ai_gateway_unreachable:
    "دروازه در دسترس نیست. نشانی دروازه را در «تنظیمات دروازه» بررسی کنید و مطمئن شوید سرویس LiteLLM در حال اجراست و از سرورِ برنامه قابل دسترسی است.",
  ai_gateway_auth: "کلید مدیر دروازه پذیرفته نشد؛ مقدار آن را در «تنظیمات دروازه» بررسی کنید.",
  ai_gateway_error: "دروازه پاسخ خطا داد؛ جزئیات دروازه را در پیام خطا ببینید.",
  ai_gateway_bad_response: "پاسخ دروازه قابل خواندن نبود و کلیدی در آن یافت نشد.",
  // Validation of the gateway settings form and the per-business form.
  ai_gateway_bad_base_url: "نشانی دروازه باید یک نشانی http یا https معتبر باشد.",
  ai_gateway_bad_fallbacks: "زنجیرهٔ جایگزین معتبر نیست؛ یک نام مستعار در هر سطر.",
  ai_gateway_bad_published_models: "فهرست مدل‌های قابل انتخاب معتبر نیست؛ یک نام در هر سطر.",
  ai_gateway_bad_usd_rate: "نرخ تبدیل دلار به ریال باید عددی بزرگ‌تر از صفر باشد.",
  ai_gateway_costing_needs_rate:
    "برای تسویه بر پایهٔ هزینهٔ دروازه، نرخ تبدیل دلار به ریال الزامی است.",
  ai_gateway_bad_margin: "حاشیهٔ سود باید عددی بزرگ‌تر یا مساوی صفر باشد.",
  ai_gateway_bad_max_turn: "سقف رزرو اعتبار هر درخواست باید عددی بزرگ‌تر از صفر باشد.",
  ai_gateway_missing_chat_model: "نام مستعار مدل گفت‌وگو الزامی است.",
  ai_gateway_costing_not_configured: "برای فعال‌سازی، هزینه‌گذاری LiteLLM یا هر دو نرخ دستی ورودی و خروجی باید معتبر باشند.",
  ai_gateway_bad_mcp_servers: "فهرست سرورهای MCP معتبر نیست.",
  ai_gateway_model_choice_disabled: "انتخاب مدل توسط کسب‌وکار در تنظیمات دروازه فعال نیست.",
  ai_gateway_model_not_published: "این مدل در فهرست مدل‌های قابل انتخاب پلتفرم نیست.",
};

/** The console translation of one `ai_gateway_*` code, when it has one. */
export function gatewayErrorText(code: string | null | undefined): string | undefined {
  return GATEWAY_ERROR_TEXT[code ?? ""];
}

/**
 * The proxy's own explanation of a failure, when it sent one. LiteLLM answers
 * in OpenAI's shape (`error.message`), FastAPI's (`detail`), or a plain string
 * — all three are read so the operator sees the *why* the proxy reported, not
 * just the status number. Long bodies are truncated; this is a console line.
 */
export function parseGatewayErrorDetail(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const row = body as Record<string, unknown>;
  const error = row.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 240);
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 240);
  }
  const detail = row.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim().slice(0, 240);
  if (Array.isArray(detail)) {
    const first = detail[0];
    if (first && typeof first === "object") {
      const message = (first as Record<string, unknown>).msg;
      if (typeof message === "string" && message.trim()) return message.trim().slice(0, 240);
    }
  }
  return null;
}

/** Attach the proxy's own explanation to a console message. */
export function joinGatewayDetail(message: string, detail: string | null | undefined): string {
  return detail ? `${message} — ${detail}` : message;
}

// ---------------------------------------------------------------------------
// Per-call resolution with Branch -> Business -> Platform fallback
// ---------------------------------------------------------------------------

/**
 * The chat model for one call.
 * Precedence: Branch override -> Business override -> Gateway alias -> Platform default.
 */
export function resolveChatModel(input: {
  platformModel: string;
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
}): string {
  const { platformModel, gateway, business, branch } = input;
  if (!gateway || !gateway.enabled) return platformModel;
  const published = gateway.publishedModels;
  if (gateway.allowBusinessModels) {
    const branchOverride = trimmed(branch?.modelOverride);
    if (branchOverride && published.includes(branchOverride)) return branchOverride;
    const businessOverride = trimmed(business?.modelOverride);
    if (businessOverride && published.includes(businessOverride)) return businessOverride;
  }
  const alias = trimmed(gateway.chatModel);
  return alias || platformModel;
}

/**
 * The embedding model for one call. Falls through to the chat model.
 */
export function resolveEmbeddingModel(input: {
  platformModel: string;
  gateway: AiGatewayConfig | null;
}): string {
  const { platformModel, gateway } = input;
  if (!gateway || !gateway.enabled) return platformModel;
  const alias = trimmed(gateway.embeddingModel);
  return alias || trimmed(gateway.chatModel) || platformModel;
}

/**
 * The credential for one call.
 * Precedence: Branch virtual key -> Business virtual key -> Gateway master key -> undefined.
 */
export function resolveGatewayAuthKey(input: {
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
  /** Tenant calls must not fall back to a shared master key when virtual keys are enabled. */
  tenantScoped?: boolean;
}): string | undefined {
  const { gateway, business, branch } = input;
  if (!gateway || !gateway.enabled) return undefined;
  if (gateway.virtualKeysEnabled) {
    if (trimmed(branch?.virtualKey)) return trimmed(branch?.virtualKey);
    if (trimmed(business?.virtualKey)) return trimmed(business?.virtualKey);
    if (input.tenantScoped) return undefined;
  }
  if (trimmed(gateway.masterKey)) return trimmed(gateway.masterKey);
  return undefined;
}

/**
 * Extra top-level request fields for one call — LiteLLM's client-side `fallbacks` chain.
 */
export function gatewayRequestBody(gateway: AiGatewayConfig | null): Record<string, unknown> {
  if (!gateway || !gateway.enabled || gateway.fallbackModels.length === 0) return {};
  return { fallbacks: [...gateway.fallbackModels] };
}

/** LiteLLM `key_alias` for a business or branch — stable, short and traceable. */
export function virtualKeyAlias(businessId: string, locationId?: string | null): string {
  const b = businessId.replace(/-/g, "").slice(0, 16);
  if (locationId) {
    const loc = locationId.replace(/-/g, "").slice(0, 8);
    return `pos-${b}-${loc}`;
  }
  return `pos-${b}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGatewayInput(input: AiGatewayInput): string[] {
  const errors: string[] = [];
  const base = trimmed(input.baseUrl);
  if (!/^https?:\/\/.+/i.test(base)) errors.push("ai_gateway_bad_base_url");

  if (input.fallbackModels !== undefined && !Array.isArray(input.fallbackModels)) {
    errors.push("ai_gateway_bad_fallbacks");
  }
  if (input.publishedModels !== undefined && !Array.isArray(input.publishedModels)) {
    errors.push("ai_gateway_bad_published_models");
  }
  if (
    input.usdRialRate !== undefined &&
    input.usdRialRate !== null &&
    !(Number.isFinite(input.usdRialRate) && input.usdRialRate > 0)
  ) {
    errors.push("ai_gateway_bad_usd_rate");
  }
  if (input.gatewayCostingEnabled && !(Number(input.usdRialRate) > 0)) {
    errors.push("ai_gateway_costing_needs_rate");
  }
  if (
    input.revenueMarginPercent !== undefined &&
    input.revenueMarginPercent !== null &&
    !(Number.isFinite(input.revenueMarginPercent) && input.revenueMarginPercent >= 0)
  ) {
    errors.push("ai_gateway_bad_margin");
  }
  if (
    input.maxTurnRial !== undefined &&
    input.maxTurnRial !== null &&
    !(Number.isFinite(input.maxTurnRial) && input.maxTurnRial >= 0)
  ) {
    errors.push("ai_gateway_bad_max_turn");
  }
  if (input.enabled === true) {
    if (!(Number(input.maxTurnRial) > 0) && !errors.includes("ai_gateway_bad_max_turn")) {
      errors.push("ai_gateway_bad_max_turn");
    }
    if (!trimmed(input.chatModel)) errors.push("ai_gateway_missing_chat_model");
    if (input.gatewayCostingEnabled !== true && !(Number(input.inputCostRialPerMillion) > 0 && Number(input.outputCostRialPerMillion) > 0)) errors.push("ai_gateway_costing_not_configured");
  }
  if (input.mcpServers !== undefined && !Array.isArray(input.mcpServers)) {
    errors.push("ai_gateway_bad_mcp_servers");
  }
  return errors;
}

export interface BusinessGatewayInput {
  modelOverride?: string | null;
}

export function validateBusinessGatewayInput(
  input: BusinessGatewayInput,
  options: { allowBusinessModels: boolean; allowedModels: string[] },
): string[] {
  const errors: string[] = [];
  if (input.modelOverride !== undefined && input.modelOverride !== null) {
    const model = trimmed(input.modelOverride);
    if (model && !options.allowBusinessModels) {
      errors.push("ai_gateway_model_choice_disabled");
    } else if (model && !options.allowedModels.includes(model)) {
      errors.push("ai_gateway_model_not_published");
    }
  }
  return errors;
}

export function normaliseBusinessGatewayInput(
  businessId: string,
  input: BusinessGatewayInput,
  locationId: string | null = null,
): BusinessGateway {
  const base = emptyBusinessGateway(businessId, locationId);
  return {
    ...base,
    modelOverride: input.modelOverride === undefined ? base.modelOverride : trimmed(input.modelOverride) || null,
  };
}

export function isGatewayActive(gateway: AiGatewayConfig | null | undefined): boolean {
  return Boolean(gateway?.enabled) && Boolean(trimmed(gateway?.baseUrl));
}

export function buildGatewayRuntime(input: {
  config: AiConfig;
  gateway: AiGatewayConfig | null;
  business?: BusinessGateway | null;
  branch?: BusinessGateway | null;
  tenantScoped?: boolean;
}): {
  model: string;
  embeddingModel: string;
  authKey?: string;
  body: Record<string, unknown>;
  virtualKeyResolved: boolean;
} | undefined {
  if (!input.gateway || !isGatewayActive(input.gateway)) return undefined;
  const gateway = input.gateway;
  const mcpBody = gatewayMcpToolsBody(gateway);
  const body = {
    ...gatewayRequestBody(gateway),
    ...mcpBody,
  };
  return {
    model: resolveChatModel({
      platformModel: input.config.model,
      gateway,
      business: input.business,
      branch: input.branch,
    }),
    embeddingModel: resolveEmbeddingModel({
      platformModel: input.config.model,
      gateway,
    }),
    virtualKeyResolved: Boolean(trimmed(input.branch?.virtualKey) || trimmed(input.business?.virtualKey)),
    ...(() => {
      const key = resolveGatewayAuthKey({ gateway, business: input.business, branch: input.branch, tenantScoped: input.tenantScoped });
      return key ? { authKey: key } : {};
    })(),
    body,
  };
}
