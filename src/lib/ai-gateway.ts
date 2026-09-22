/**
 * Technical LiteLLM Gateway definitions and pure utility functions.
 *
 * This module manages:
 * - LiteLLM connection parameters (baseUrl, masterKey)
 * - Model aliases (chatModel, embeddingModel)
 * - Per-business virtual key resolution (runtime identity)
 * - Multi-stage connection probe contracts
 * - OpenAI-compatible error parsing
 *
 * All billing, allowances, pricing, token rates, and tenant monetization
 * belong strictly to Plan/Billing (/platform/plans).
 */
import type { AiConfig } from "./ai";

export interface AiGatewayConfig {
  enabled: boolean;
  baseUrl: string;
  masterKey: string;
  chatModel: string;
  embeddingModel: string;
  virtualKeysEnabled: boolean;
  allowBusinessModels: boolean;
  publishedModels: string[];
  fallbackModels?: string[];
  mcpEnabled?: boolean;
  mcpServers?: McpServerConfig[];
}

export interface McpServerConfig {
  name: string;
  label: string;
  url: string;
}

export interface BusinessGateway {
  businessId: string;
  locationId: string | null;
  virtualKey: string | null;
  keyAlias: string | null;
  modelOverride: string | null;
  spendUsd: number;
  syncedAt: string | null;
  syncError: string | null;
}

export interface AiGatewayInput {
  enabled?: boolean;
  baseUrl?: string;
  masterKey?: string;
  chatModel?: string;
  embeddingModel?: string;
  virtualKeysEnabled?: boolean;
  allowBusinessModels?: boolean;
  publishedModels?: string[] | string;
  fallbackModels?: string[] | string;
}

export interface BusinessGatewayInput {
  modelOverride?: string | null;
}

export interface GatewayProbeStage {
  id: "liveliness" | "auth" | "model" | "completion" | "virtual_keys";
  label: string;
  ok: boolean;
  error?: string | null;
  detail?: string | null;
}

export interface GatewayStatus {
  ok: boolean;
  latencyMs: number | null;
  models: string[];
  stages?: GatewayProbeStage[];
  error: string | null;
  detail?: string | null;
}

export interface GatewayRuntime {
  model: string;
  embeddingModel: string;
  authKey?: string;
  virtualKeyResolved?: boolean;
  body: Record<string, unknown>;
}

export function defaultGatewayConfig(): AiGatewayConfig {
  return {
    enabled: false,
    baseUrl: "http://litellm:4000/v1",
    masterKey: "",
    chatModel: "",
    embeddingModel: "",
    virtualKeysEnabled: true,
    allowBusinessModels: false,
    publishedModels: [],
    fallbackModels: [],
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

export function isGatewayActive(gateway: AiGatewayConfig | null | undefined): boolean {
  return Boolean(gateway && gateway.enabled && gateway.baseUrl);
}

export function gatewayManagementUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

export function livelinessUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/health/liveliness`;
}

export function modelInfoUrl(baseUrl: string): string {
  return `${gatewayManagementUrl(baseUrl)}/model/info`;
}

export function keyInfoUrl(baseUrl: string, key: string): string {
  return `${gatewayManagementUrl(baseUrl)}/key/info?key=${encodeURIComponent(key)}`;
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

export function virtualKeyAlias(businessId: string, locationId: string | null = null): string {
  const cleanBiz = businessId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "tenant";
  if (!locationId) return `pos-${cleanBiz}`;
  const cleanLoc = locationId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  return `pos-${cleanBiz}-${cleanLoc}`;
}

export function resolveChatModel(opts: {
  platformModel: string;
  gateway: AiGatewayConfig | null | undefined;
  business: BusinessGateway | null | undefined;
  branch?: BusinessGateway | null | undefined;
}): string {
  const { platformModel, gateway, business, branch } = opts;
  if (!gateway || !gateway.enabled) return platformModel;

  const effectivePublished = new Set(gateway.publishedModels ?? []);
  const branchOverride = branch?.modelOverride?.trim();
  if (gateway.allowBusinessModels && branchOverride && effectivePublished.has(branchOverride)) {
    return branchOverride;
  }

  const bizOverride = business?.modelOverride?.trim();
  if (gateway.allowBusinessModels && bizOverride && effectivePublished.has(bizOverride)) {
    return bizOverride;
  }

  return gateway.chatModel?.trim() || platformModel;
}

export function resolveEmbeddingModel(opts: {
  platformModel: string;
  gateway: AiGatewayConfig | null | undefined;
}): string {
  const { platformModel, gateway } = opts;
  if (!gateway || !gateway.enabled) return platformModel;
  return gateway.embeddingModel?.trim() || gateway.chatModel?.trim() || platformModel;
}

export function resolveGatewayAuthKey(opts: {
  gateway: AiGatewayConfig | null | undefined;
  business: BusinessGateway | null | undefined;
  branch?: BusinessGateway | null | undefined;
  tenantScoped?: boolean;
}): string | undefined {
  const { gateway, business, branch, tenantScoped } = opts;
  if (!gateway || !gateway.enabled) return undefined;

  if (gateway.virtualKeysEnabled) {
    if (branch?.virtualKey?.trim()) return branch.virtualKey.trim();
    if (business?.virtualKey?.trim()) return business.virtualKey.trim();
    if (tenantScoped) return undefined;
    return gateway.masterKey?.trim() || undefined;
  }

  return gateway.masterKey?.trim() || undefined;
}

export function gatewayRequestBody(gateway: AiGatewayConfig | null | undefined): Record<string, unknown> {
  if (!gateway || !gateway.enabled) return {};
  return {};
}

export function gatewayMcpToolsBody(gateway: AiGatewayConfig | null | undefined): Record<string, unknown> {
  return {};
}

export function normalizeMcpServers(input: unknown): McpServerConfig[] {
  if (!Array.isArray(input)) return [];
  const result: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim().toLowerCase() : "";
      const label = typeof row.label === "string" ? row.label.trim() : name;
      const url = typeof row.url === "string" ? row.url.trim() : "";
      if (name && url && !seen.has(name)) {
        seen.add(name);
        result.push({ name, label, url });
      }
    }
  }
  return result;
}

export function mcpServersToText(servers: McpServerConfig[]): string {
  return servers.map((s) => `${s.name} | ${s.label} | ${s.url}`).join("\n");
}

export function mcpServersFromText(text: string): McpServerConfig[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const result: McpServerConfig[] = [];
  for (const line of lines) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length >= 3 && parts[0] && parts[2]) {
      result.push({ name: parts[0].toLowerCase(), label: parts[1] || parts[0], url: parts[2] });
    }
  }
  return result;
}

export function buildGatewayRuntime(opts: {
  config: AiConfig;
  gateway: AiGatewayConfig | null | undefined;
  business: BusinessGateway | null | undefined;
  branch?: BusinessGateway | null | undefined;
  tenantScoped?: boolean;
}): GatewayRuntime | undefined {
  const { config, gateway, business, branch, tenantScoped } = opts;
  if (!gateway || !gateway.enabled) return undefined;

  const authKey = resolveGatewayAuthKey({ gateway, business, branch, tenantScoped });
  const virtualKeyResolved = Boolean(gateway.virtualKeysEnabled && (branch?.virtualKey || business?.virtualKey));

  return {
    model: resolveChatModel({ platformModel: config.model, gateway, business, branch }),
    embeddingModel: resolveEmbeddingModel({ platformModel: config.model, gateway }),
    authKey,
    virtualKeyResolved,
    body: {},
  };
}

export function toStringList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof input === "string") {
    return input
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function toListText(list: string[]): string {
  return list.join("\n");
}

export function validateGatewayInput(input: AiGatewayInput): string[] {
  const errors: string[] = [];
  if (input.baseUrl !== undefined) {
    const url = input.baseUrl.trim();
    if (url && !/^https?:\/\/.+/i.test(url)) {
      errors.push("ai_gateway_bad_base_url");
    }
  }
  return errors;
}

export function validateBusinessGatewayInput(
  input: BusinessGatewayInput,
  options: { allowBusinessModels: boolean; allowedModels: string[] },
): string[] {
  const errors: string[] = [];
  if (input.modelOverride !== undefined && input.modelOverride !== null) {
    const model = input.modelOverride.trim();
    if (model) {
      if (!options.allowBusinessModels) {
        errors.push("ai_gateway_model_choice_disabled");
      } else if (!options.allowedModels.includes(model)) {
        errors.push("ai_gateway_model_not_published");
      }
    }
  }
  return errors;
}

export function normaliseBusinessGatewayInput(
  businessId: string,
  input: BusinessGatewayInput,
  locationId: string | null = null,
): BusinessGateway {
  const row = emptyBusinessGateway(businessId, locationId);
  const model = input.modelOverride?.trim();
  row.modelOverride = model || null;
  return row;
}

export function toPublicGatewayConfig(gateway: AiGatewayConfig): Record<string, unknown> {
  return {
    enabled: gateway.enabled,
    baseUrl: gateway.baseUrl,
    chatModel: gateway.chatModel,
    embeddingModel: gateway.embeddingModel,
    virtualKeysEnabled: gateway.virtualKeysEnabled,
    allowBusinessModels: gateway.allowBusinessModels,
    publishedModels: gateway.publishedModels ?? [],
    hasMasterKey: Boolean(gateway.masterKey && gateway.masterKey.trim().length > 0),
  };
}

export function parseGatewayModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  const rawList = Array.isArray(obj.data) ? obj.data : Array.isArray(obj.models) ? obj.models : [];
  const models: string[] = [];
  for (const item of rawList) {
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      const name = typeof row.model_name === "string" ? row.model_name : typeof row.id === "string" ? row.id : "";
      if (name && !models.includes(name)) {
        models.push(name);
      }
    }
  }
  return models;
}

export function parseGeneratedKey(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.key === "string" && obj.key.trim()) return obj.key.trim();
  if (typeof obj.token === "string" && obj.token.trim()) return obj.token.trim();
  return null;
}

export function parseKeySpend(body: unknown): { spendUsd: number; maxBudgetUsd: number | null } | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const info = obj.info && typeof obj.info === "object" ? (obj.info as Record<string, unknown>) : obj;
  if ("spend" in info && typeof info.spend === "number") {
    const spendUsd = Math.max(0, info.spend);
    const maxBudgetUsd = typeof info.max_budget === "number" ? info.max_budget : null;
    return { spendUsd, maxBudgetUsd };
  }
  return null;
}

export function parseResponseCostHeader(header: string | null | undefined): number | null {
  if (header === null || header === undefined || header === "") return null;
  const parsed = parseFloat(header);
  return !isNaN(parsed) && parsed >= 0 ? parsed : null;
}

export function rialFromGatewayUsd(usd: number, usdRialRate: number): number {
  if (usd <= 0 || usdRialRate <= 0) return 0;
  return Math.ceil(usd * usdRialRate);
}

export function gatewayTurnPricing(usd: number, usdRialRate: number, marginPercent: number): {
  costRial: number;
  chargedRial: number;
} {
  const costRial = rialFromGatewayUsd(usd, usdRialRate);
  if (costRial <= 0) return { costRial: 0, chargedRial: 0 };
  const marginMultiplier = 1 + Math.max(0, marginPercent) / 100;
  const chargedRial = Math.max(costRial, Math.ceil(costRial * marginMultiplier));
  return { costRial, chargedRial };
}

export function parseGatewayErrorDetail(body: unknown): string | null {
  if (!body) return null;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      return parseGatewayErrorDetail(parsed);
    } catch {
      return null;
    }
  }
  if (typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.detail === "string" && obj.detail.trim()) {
    return obj.detail.trim().slice(0, 240);
  }
  if (Array.isArray(obj.detail) && obj.detail.length > 0) {
    const first = obj.detail[0];
    if (first && typeof first === "object" && typeof (first as Record<string, unknown>).msg === "string") {
      return ((first as Record<string, unknown>).msg as string).trim().slice(0, 240);
    }
  }
  if (obj.error && typeof obj.error === "object") {
    const errObj = obj.error as Record<string, unknown>;
    if (typeof errObj.message === "string" && errObj.message.trim()) {
      return errObj.message.trim().slice(0, 240);
    }
  }
  if (typeof obj.error === "string" && obj.error.trim()) {
    return obj.error.trim().slice(0, 240);
  }
  return null;
}

const GATEWAY_ERROR_MESSAGES: Record<string, string> = {
  ai_gateway_disabled: "دروازه هوش مصنوعی غیرفعال است.",
  ai_gateway_missing_master_key: "کلید مدیر (Master Key) دروازه ثبت نشده است.",
  ai_gateway_virtual_keys_disabled: "صدور کلیدهای مجازی غیرفعال است.",
  ai_gateway_unreachable: "دروازه هوش مصنوعی در دسترس نیست.",
  ai_gateway_auth: "احراز هویت با دروازه با شکست مواجه شد؛ کلید مدیر نامعتبر است.",
  ai_gateway_error: "پاسخ ناموفق از دروازه هوش مصنوعی.",
  ai_gateway_bad_response: "پاسخ دروازه نامعتبر یا غیرقابل خواندن است.",
  ai_gateway_bad_base_url: "نشانی دروازه معتبر نیست.",
  ai_gateway_model_choice_disabled: "انتخاب مدل اختصاصی توسط پلتفرم غیرفعال شده است.",
  ai_gateway_model_not_published: "مدل انتخاب‌شده در لیست مدل‌های مجاز پلتفرم نیست.",
  ai_gateway_model_not_found: "نام مستعار مدل گفت‌وگو در فهرست مدل‌های LiteLLM یافت نشد.",
  ai_gateway_completion_failed: "تست ارسال پیام به مدل در LiteLLM با خطا مواجه شد.",
  ai_gateway_virtual_keys_unhealthy: "سرویس کلیدهای مجازی LiteLLM عملیاتی نیست.",
};

export function gatewayErrorText(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return GATEWAY_ERROR_MESSAGES[code];
}

export function joinGatewayDetail(message: string, detail: string | null | undefined): string {
  return detail ? `${message} — ${detail}` : message;
}

export function gatewayStatusMessage(statusCode: number): string {
  switch (statusCode) {
    case 200:
      return "ارتباط برقرار است.";
    case 401:
    case 403:
      return "کلید مدیر دروازه پذیرفته نشد (نامعتبر یا فاقد دسترسی).";
    case 404:
      return "مسیر مورد نظر در دروازه یافت نشد.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "خطای داخلی در دروازه هوش مصنوعی.";
    default:
      return `پاسخ با کد وضعیت ${statusCode} دریافت شد.`;
  }
}

export interface ParsedProviderError {
  status: number;
  type?: string;
  code?: string;
  sanitizedReason: string;
}

export type PublicAiGatewayConfig = Record<string, unknown>;
export type PublicBusinessGateway = Omit<BusinessGateway, "virtualKey"> & {
  hasVirtualKey: boolean;
  effectiveModel: string;
};
export interface AiGatewayTurnPricing { costUsd: number; costRial: number; chargedRial: number; }
export type GatewayProbe = GatewayStatus;

export function parseProviderError(status: number, responseBody: string): ParsedProviderError {
  let detail: string | null = null;
  let type: string | undefined;
  let code: string | undefined;

  try {
    const json = JSON.parse(responseBody);
    detail = parseGatewayErrorDetail(json);
    if (json && typeof json === "object") {
      const err = (json as Record<string, unknown>).error;
      if (err && typeof err === "object") {
        const errObj = err as Record<string, unknown>;
        if (typeof errObj.type === "string") type = errObj.type;
        if (typeof errObj.code === "string" || typeof errObj.code === "number") code = String(errObj.code);
      }
    }
  } catch {
    if (responseBody && responseBody.length < 300) {
      detail = responseBody.trim();
    }
  }

  const sanitizedReason = detail ? detail.replace(/sk-[a-zA-Z0-9_-]{8,}/g, "sk-***").slice(0, 240) : `HTTP ${status}`;

  return {
    status,
    type,
    code,
    sanitizedReason,
  };
}
