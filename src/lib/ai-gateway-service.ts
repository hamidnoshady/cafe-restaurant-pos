/**
 * Phase 37 — the gateway's server half: the singleton gateway row, each
 * business's slice of it, and the calls to the gateway's own management API.
 *
 * Two rules shape this file.
 *
 * 1. **A gateway failure is never an assistant failure.** Every HTTP call here
 *    returns a result object instead of throwing; the only place that matters
 *    is the request path, and a deployment that was working before the gateway
 *    was introduced must keep working when the gateway container is stopped.
 *    The one exception is provisioning, which is an explicit operator action:
 *    there the operator has asked for something and is entitled to hear why it
 *    did not happen.
 *
 * 2. **Tenant scope is the caller's, not this module's.** `saveBusinessGateway`
 *    takes an explicit `business_id` and writes through the ordinary
 *    `query()`, exactly as Phase 18's credit writes do: from the platform
 *    console the ambient scope is the documented `platform` bypass and any
 *    business may be addressed, while from a business's own settings page RLS
 *    confines the write to the session's business — so a forged business id is
 *    refused rather than merely ignored.
 */
import { query, withoutTenantScope } from "./db";
import {
  aggregateSpendLogs,
  defaultGatewayConfig,
  gatewayTurnPricing,
  emptyBusinessGateway,
  gatewayManagementUrl,
  gatewayStatusMessage,
  keyDeleteUrl,
  keyGenerateUrl,
  keyInfoUrl,
  keyModelsFor,
  keyUpdateUrl,
  livelinessUrl,
  modelInfoUrl,
  normalizeMcpServers,
  normalizePromptBindings,
  parseGatewayModels,
  parseGeneratedKey,
  parseKeySpend,
  parseSpendLogs,
  resolveChatModel,
  spendLogsUrl,
  toPublicGatewayConfig,
  toStringList,
  validateBusinessGatewayInput,
  validateGatewayInput,
  virtualKeyAlias,
  type AiGatewayConfig,
  type AiGatewayInput,
  type BusinessGateway,
  type BusinessGatewayInput,
  type GatewayProbe,
  type GatewayRoutingStrategy,
  type PublicAiGatewayConfig,
  type PublicBusinessGateway,
} from "./ai-gateway";
import type { AiGatewayTurnPricing } from "./ai-billing-service";

/** Management calls are operator-facing: fail them fast rather than hang a page. */
const MANAGEMENT_TIMEOUT_MS = 10_000;

function numberValue(value: string | number | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function optionalNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function optionalInteger(value: string | number | null | undefined): number | null {
  const n = Number(value ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function textOr(value: string | null | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

// ---------------------------------------------------------------------------
// The deployment-wide gateway row
// ---------------------------------------------------------------------------

type GatewayRow = {
  enabled: boolean;
  base_url: string;
  master_key: string | null;
  chat_model: string;
  embedding_model: string;
  fallback_models: unknown;
  routing_strategy: string;
  virtual_keys_enabled: boolean;
  allow_business_models: boolean;
  published_models: unknown;
  default_max_budget_usd: string | null;
  default_budget_duration: string;
  default_tpm_limit: number | null;
  default_rpm_limit: number | null;
  usd_rial_rate: string | null;
  gateway_costing_enabled: boolean;
  prompt_bindings: unknown;
  mcp_enabled: boolean;
  mcp_servers: unknown;
};

function rowToGateway(row: GatewayRow): AiGatewayConfig {
  const fallback = defaultGatewayConfig();
  return {
    enabled: row.enabled,
    baseUrl: textOr(row.base_url, fallback.baseUrl),
    masterKey: row.master_key ?? "",
    chatModel: row.chat_model ?? "",
    embeddingModel: row.embedding_model ?? "",
    fallbackModels: toStringList(row.fallback_models),
    routingStrategy: (row.routing_strategy ?? fallback.routingStrategy) as GatewayRoutingStrategy,
    virtualKeysEnabled: row.virtual_keys_enabled,
    allowBusinessModels: row.allow_business_models,
    publishedModels: toStringList(row.published_models),
    defaultMaxBudgetUsd: optionalNumber(row.default_max_budget_usd),
    defaultBudgetDuration: textOr(row.default_budget_duration, fallback.defaultBudgetDuration),
    defaultTpmLimit: optionalInteger(row.default_tpm_limit),
    defaultRpmLimit: optionalInteger(row.default_rpm_limit),
    usdRialRate: optionalNumber(row.usd_rial_rate),
    gatewayCostingEnabled: row.gateway_costing_enabled,
    promptBindings: normalizePromptBindings(row.prompt_bindings),
    mcpEnabled: row.mcp_enabled,
    mcpServers: normalizeMcpServers(row.mcp_servers),
  };
}

/** The gateway settings, or a switched-off default when the row has never been written. */
export async function getAiGatewayConfig(): Promise<AiGatewayConfig> {
  const { rows } = await query<GatewayRow>(
    `SELECT enabled, base_url, master_key, chat_model, embedding_model,
            fallback_models, routing_strategy, virtual_keys_enabled,
            allow_business_models, published_models, default_max_budget_usd,
            default_budget_duration, default_tpm_limit, default_rpm_limit,
            usd_rial_rate, gateway_costing_enabled, prompt_bindings,
            mcp_enabled, mcp_servers
       FROM platform_ai_gateway
      WHERE id = true`,
  );
  return rows[0] ? rowToGateway(rows[0]) : defaultGatewayConfig();
}

export function toPublicAiGatewayConfig(config: AiGatewayConfig): PublicAiGatewayConfig {
  return toPublicGatewayConfig(config);
}

/** Env-supplied defaults, so a deployment can be configured without a DB round-trip. */
function envGatewayConfig(): Partial<AiGatewayInput> {
  const env = process.env;
  const budget = Number(env.LITELLM_DEFAULT_MAX_BUDGET_USD ?? "");
  const tpm = Number(env.LITELLM_DEFAULT_TPM_LIMIT ?? "");
  const rpm = Number(env.LITELLM_DEFAULT_RPM_LIMIT ?? "");
  const usdRate = Number(env.LITELLM_USD_RIAL_RATE ?? "");
  return {
    enabled: env.LITELLM_ENABLED === "true",
    baseUrl: env.LITELLM_BASE_URL?.trim() || undefined,
    masterKey: env.LITELLM_MASTER_KEY?.trim() || undefined,
    chatModel: env.LITELLM_CHAT_MODEL?.trim() || undefined,
    embeddingModel: env.LITELLM_EMBEDDING_MODEL?.trim() || undefined,
    fallbackModels: env.LITELLM_FALLBACK_MODELS ? env.LITELLM_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean) : undefined,
    defaultMaxBudgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
    defaultTpmLimit: Number.isSafeInteger(tpm) && tpm > 0 ? tpm : null,
    defaultRpmLimit: Number.isSafeInteger(rpm) && rpm > 0 ? rpm : null,
    usdRialRate: Number.isFinite(usdRate) && usdRate > 0 ? usdRate : null,
  };
}

/**
 * Overlay a partial draft onto the stored settings.
 *
 * Used by the console's "test connection" button, which must probe the
 * connection as the operator has typed it — including an address or admin key
 * that has not been saved yet — without writing anything.
 */
export function mergeGatewayConfig(draft: AiGatewayInput, current: AiGatewayConfig): AiGatewayConfig {
  return {
    enabled: draft.enabled ?? current.enabled,
    baseUrl: (draft.baseUrl ?? current.baseUrl).trim() || current.baseUrl,
    masterKey: draft.masterKey?.trim() || current.masterKey,
    chatModel: draft.chatModel ?? current.chatModel,
    embeddingModel: draft.embeddingModel ?? current.embeddingModel,
    fallbackModels: draft.fallbackModels === undefined ? current.fallbackModels : toStringList(draft.fallbackModels),
    routingStrategy: (draft.routingStrategy ?? current.routingStrategy) as GatewayRoutingStrategy,
    virtualKeysEnabled: draft.virtualKeysEnabled ?? current.virtualKeysEnabled,
    allowBusinessModels: draft.allowBusinessModels ?? current.allowBusinessModels,
    publishedModels:
      draft.publishedModels === undefined ? current.publishedModels : toStringList(draft.publishedModels),
    defaultMaxBudgetUsd: pickOptionalNumber(draft.defaultMaxBudgetUsd, current.defaultMaxBudgetUsd),
    defaultBudgetDuration: (draft.defaultBudgetDuration ?? current.defaultBudgetDuration).trim() || current.defaultBudgetDuration,
    defaultTpmLimit: pickOptionalNumber(draft.defaultTpmLimit, current.defaultTpmLimit),
    defaultRpmLimit: pickOptionalNumber(draft.defaultRpmLimit, current.defaultRpmLimit),
    usdRialRate: pickOptionalNumber(draft.usdRialRate, current.usdRialRate),
    gatewayCostingEnabled: draft.gatewayCostingEnabled ?? current.gatewayCostingEnabled,
    promptBindings:
      draft.promptBindings === undefined
        ? current.promptBindings
        : normalizePromptBindings(draft.promptBindings),
    mcpEnabled: draft.mcpEnabled ?? current.mcpEnabled,
    mcpServers: draft.mcpServers === undefined ? current.mcpServers : normalizeMcpServers(draft.mcpServers),
  };
}

/**
 * `undefined` means "not mentioned, keep the stored value"; `null` means
 * "explicitly cleared". Without that distinction an operator could set a
 * budget and never remove it, because the null would be silently replaced by
 * the value it was meant to erase.
 */
function pickOptionalNumber(value: number | null | undefined, current: number | null): number | null {
  if (value === undefined) return current;
  return optionalNumber(value);
}

/**
 * Persist the gateway settings.
 *
 * A blank master key preserves the stored one, mirroring `savePlatformAiConfig`:
 * an operator adjusting the failover chain must not have to re-send the
 * gateway's admin credential to do it.
 */
export async function saveAiGatewayConfig(input: AiGatewayInput): Promise<AiGatewayConfig> {
  const errors = validateGatewayInput(input);
  if (errors.length > 0) throw new Error(errors[0]);
  const current = await getAiGatewayConfig();
  const masterKey = input.masterKey?.trim() || current.masterKey || null;
  await query(
    `INSERT INTO platform_ai_gateway
       (id, enabled, base_url, master_key, chat_model, embedding_model,
        fallback_models, routing_strategy, virtual_keys_enabled,
        allow_business_models, published_models, default_max_budget_usd,
        default_budget_duration, default_tpm_limit, default_rpm_limit,
        usd_rial_rate, gateway_costing_enabled, prompt_bindings,
        mcp_enabled, mcp_servers, updated_at)
     VALUES
       (true, $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12, $13, $14,
        $15, $16, $17::jsonb, $18, $19::jsonb, now())
     ON CONFLICT (id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   base_url = EXCLUDED.base_url,
                   master_key = EXCLUDED.master_key,
                   chat_model = EXCLUDED.chat_model,
                   embedding_model = EXCLUDED.embedding_model,
                   fallback_models = EXCLUDED.fallback_models,
                   routing_strategy = EXCLUDED.routing_strategy,
                   virtual_keys_enabled = EXCLUDED.virtual_keys_enabled,
                   allow_business_models = EXCLUDED.allow_business_models,
                   published_models = EXCLUDED.published_models,
                   default_max_budget_usd = EXCLUDED.default_max_budget_usd,
                   default_budget_duration = EXCLUDED.default_budget_duration,
                   default_tpm_limit = EXCLUDED.default_tpm_limit,
                   default_rpm_limit = EXCLUDED.default_rpm_limit,
                   usd_rial_rate = EXCLUDED.usd_rial_rate,
                   gateway_costing_enabled = EXCLUDED.gateway_costing_enabled,
                   prompt_bindings = EXCLUDED.prompt_bindings,
                   mcp_enabled = EXCLUDED.mcp_enabled,
                   mcp_servers = EXCLUDED.mcp_servers,
                   updated_at = now()`,
    [
      input.enabled ?? current.enabled,
      (input.baseUrl ?? current.baseUrl).trim(),
      masterKey,
      (input.chatModel ?? current.chatModel).trim(),
      (input.embeddingModel ?? current.embeddingModel).trim(),
      JSON.stringify(toStringList(input.fallbackModels ?? current.fallbackModels)),
      (input.routingStrategy ?? current.routingStrategy) as GatewayRoutingStrategy,
      input.virtualKeysEnabled ?? current.virtualKeysEnabled,
      input.allowBusinessModels ?? current.allowBusinessModels,
      JSON.stringify(toStringList(input.publishedModels ?? current.publishedModels)),
      pickOptionalNumber(input.defaultMaxBudgetUsd, current.defaultMaxBudgetUsd),
      (input.defaultBudgetDuration ?? current.defaultBudgetDuration).trim(),
      pickOptionalNumber(input.defaultTpmLimit, current.defaultTpmLimit),
      pickOptionalNumber(input.defaultRpmLimit, current.defaultRpmLimit),
      pickOptionalNumber(input.usdRialRate, current.usdRialRate),
      input.gatewayCostingEnabled ?? current.gatewayCostingEnabled,
      JSON.stringify(
        input.promptBindings === undefined
          ? current.promptBindings
          : normalizePromptBindings(input.promptBindings),
      ),
      input.mcpEnabled ?? current.mcpEnabled,
      JSON.stringify(
        input.mcpServers === undefined ? current.mcpServers : normalizeMcpServers(input.mcpServers),
      ),
    ],
  );
  return getAiGatewayConfig();
}

// ---------------------------------------------------------------------------
// One business's slice
// ---------------------------------------------------------------------------

type BusinessGatewayRow = {
  business_id: string;
  virtual_key: string | null;
  key_alias: string | null;
  model_override: string | null;
  max_budget_usd: string | null;
  budget_duration: string | null;
  tpm_limit: number | null;
  rpm_limit: number | null;
  spend_usd: string | null;
  synced_at: string | null;
  sync_error: string | null;
};

function rowToBusinessGateway(row: BusinessGatewayRow): BusinessGateway {
  return {
    businessId: row.business_id,
    virtualKey: row.virtual_key ?? null,
    keyAlias: row.key_alias ?? null,
    modelOverride: row.model_override ?? null,
    maxBudgetUsd: optionalNumber(row.max_budget_usd),
    budgetDuration: row.budget_duration ?? null,
    tpmLimit: optionalInteger(row.tpm_limit),
    rpmLimit: optionalInteger(row.rpm_limit),
    spendUsd: numberValue(row.spend_usd),
    syncedAt: row.synced_at,
    syncError: row.sync_error ?? null,
  };
}

/**
 * This business's gateway row, read under whatever scope the caller already
 * has. Returns null when the business has none — which is a normal state, not
 * an error, and means "use the shared connection".
 */
export async function getBusinessGateway(businessId: string): Promise<BusinessGateway | null> {
  const { rows } = await query<BusinessGatewayRow>(
    `SELECT business_id, virtual_key, key_alias, model_override, max_budget_usd,
            budget_duration, tpm_limit, rpm_limit, spend_usd, synced_at, sync_error
       FROM ai_business_gateway
      WHERE business_id = $1`,
    [businessId],
  );
  return rows[0] ? rowToBusinessGateway(rows[0]) : null;
}

/** Every business's gateway row, for the console. Platform scope only. */
export async function listBusinessGateways(): Promise<BusinessGateway[]> {
  return withoutTenantScope("platform", async () => {
    const { rows } = await query<BusinessGatewayRow>(
      `SELECT business_id, virtual_key, key_alias, model_override, max_budget_usd,
              budget_duration, tpm_limit, rpm_limit, spend_usd, synced_at, sync_error
         FROM ai_business_gateway`,
    );
    return rows.map(rowToBusinessGateway);
  });
}

/**
 * Upsert one business's gateway settings.
 *
 * The model override is validated against the platform's published list here
 * as well as in the route: this is the last place before the write, and a
 * check that only existed in the route could be bypassed by any future caller.
 */
export async function saveBusinessGateway(
  businessId: string,
  input: BusinessGatewayInput,
  gateway: AiGatewayConfig,
): Promise<BusinessGateway> {
  const errors = validateBusinessGatewayInput(input, {
    allowBusinessModels: gateway.allowBusinessModels,
    allowedModels: gateway.publishedModels,
  });
  if (errors.length > 0) throw new Error(errors[0]);
  await query(
    `INSERT INTO ai_business_gateway
       (business_id, model_override, max_budget_usd, budget_duration, tpm_limit, rpm_limit, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (business_id)
     DO UPDATE SET model_override = EXCLUDED.model_override,
                   max_budget_usd = EXCLUDED.max_budget_usd,
                   budget_duration = EXCLUDED.budget_duration,
                   tpm_limit = EXCLUDED.tpm_limit,
                   rpm_limit = EXCLUDED.rpm_limit,
                   updated_at = now()`,
    [
      businessId,
      input.modelOverride === undefined ? null : (input.modelOverride ?? "").trim() || null,
      optionalNumber(input.maxBudgetUsd),
      (input.budgetDuration ?? "").trim() || null,
      optionalInteger(input.tpmLimit),
      optionalInteger(input.rpmLimit),
    ],
  );
  return (await getBusinessGateway(businessId)) ?? emptyBusinessGateway(businessId);
}

/** Record a virtual key against a business. Platform scope. */
async function storeVirtualKey(input: {
  businessId: string;
  virtualKey: string;
  keyAlias: string;
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  syncError?: string | null;
}): Promise<BusinessGateway> {
  return withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO ai_business_gateway
         (business_id, virtual_key, key_alias, max_budget_usd, budget_duration,
          tpm_limit, rpm_limit, synced_at, sync_error, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8::text IS NULL THEN now() ELSE NULL END, $8, now())
       ON CONFLICT (business_id)
       DO UPDATE SET virtual_key = EXCLUDED.virtual_key,
                     key_alias = EXCLUDED.key_alias,
                     max_budget_usd = COALESCE(EXCLUDED.max_budget_usd, ai_business_gateway.max_budget_usd),
                     budget_duration = COALESCE(EXCLUDED.budget_duration, ai_business_gateway.budget_duration),
                     tpm_limit = EXCLUDED.tpm_limit,
                     rpm_limit = EXCLUDED.rpm_limit,
                     synced_at = CASE WHEN $8::text IS NULL THEN now() ELSE ai_business_gateway.synced_at END,
                     sync_error = EXCLUDED.sync_error,
                     updated_at = now()`,
      [
        input.businessId,
        input.virtualKey,
        input.keyAlias,
        input.maxBudgetUsd,
        input.budgetDuration,
        input.tpmLimit,
        input.rpmLimit,
        input.syncError ?? null,
      ],
    );
    return (await getBusinessGateway(input.businessId)) ?? emptyBusinessGateway(input.businessId);
  });
}

/** Forget the virtual key and the row that held it. Platform scope. */
export async function clearVirtualKey(businessId: string): Promise<void> {
  await withoutTenantScope("platform", async () => {
    await query("DELETE FROM ai_business_gateway WHERE business_id = $1", [businessId]);
  });
}

// ---------------------------------------------------------------------------
// The gateway's own management API
// ---------------------------------------------------------------------------

interface GatewayResponse {
  status: number;
  body: unknown;
}

/**
 * One call to the gateway. Never throws: `status: 0` means the gateway could
 * not be reached at all, which every caller treats as "not available" rather
 * than as an error to propagate.
 */
async function gatewayRequest(
  config: AiGatewayConfig,
  url: string,
  init: { method: "GET" | "POST"; body?: unknown },
): Promise<GatewayResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANAGEMENT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        "Content-Type": "application/json",
        ...(config.masterKey ? { Authorization: `Bearer ${config.masterKey}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export interface GatewayCallError {
  code: string;
  message: string;
}

function asError(status: number): GatewayCallError {
  if (status === 0) {
    return { code: "ai_gateway_unreachable", message: "دروازه در دسترس نیست (اتصال برقرار نشد)." };
  }
  return { code: status === 401 || status === 403 ? "ai_gateway_auth" : "ai_gateway_error", message: gatewayStatusMessage(status) };
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Liveness plus the model list — the console's "test connection" button. */
export async function probeGateway(config: AiGatewayConfig): Promise<GatewayProbe> {
  const started = Date.now();
  const health = await gatewayRequest(config, livelinessUrl(config.baseUrl), { method: "GET" });
  if (!ok(health.status)) {
    return { ok: false, latencyMs: null, models: [], error: asError(health.status).message };
  }
  const latencyMs = Date.now() - started;
  const models = config.masterKey
    ? await listGatewayModels(config)
    : [];
  return { ok: true, latencyMs, models, error: null };
}

/** Model aliases the gateway is serving. Empty when the admin key is absent. */
export async function listGatewayModels(config: AiGatewayConfig): Promise<string[]> {
  if (!config.masterKey) return [];
  const res = await gatewayRequest(config, modelInfoUrl(config.baseUrl), { method: "GET" });
  return ok(res.status) ? parseGatewayModels(res.body) : [];
}

export interface VirtualKeyInput {
  businessId: string;
  /** The model the platform will send, plus its fallbacks — the key's allowlist. */
  models: string[];
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
}

/**
 * Mint (or refresh) the virtual key for one business and store it.
 *
 * Throws a `GatewayCallError`-shaped object's message through `Error` only for
 * the operator-initiated provisioning path, where silence would be worse than
 * a failure: an admin pressing "sync" is entitled to know it did not happen.
 */
export async function provisionVirtualKey(
  config: AiGatewayConfig,
  platformModel: string,
  input: VirtualKeyInput,
): Promise<BusinessGateway> {
  const alias = virtualKeyAlias(input.businessId);
  const existing = await getBusinessGatewayOrEmpty(input.businessId);
  const models = input.models.length > 0 ? input.models : keyModelsFor({ platformModel, gateway: config, business: existing });
  const limits = {
    models,
    max_budget: input.maxBudgetUsd ?? undefined,
    budget_duration: input.budgetDuration ?? undefined,
    tpm_limit: input.tpmLimit ?? undefined,
    rpm_limit: input.rpmLimit ?? undefined,
  };

  if (existing?.virtualKey) {
    const res = await gatewayRequest(config, keyUpdateUrl(config.baseUrl), {
      method: "POST",
      body: { key: existing.virtualKey, ...limits },
    });
    if (!ok(res.status)) {
      const error = asError(res.status);
      return storeVirtualKey({
        businessId: input.businessId,
        virtualKey: existing.virtualKey,
        keyAlias: alias,
        maxBudgetUsd: input.maxBudgetUsd,
        budgetDuration: input.budgetDuration,
        tpmLimit: input.tpmLimit,
        rpmLimit: input.rpmLimit,
        syncError: error.message,
      });
    }
    return storeVirtualKey({
      businessId: input.businessId,
      virtualKey: existing.virtualKey,
      keyAlias: alias,
      maxBudgetUsd: input.maxBudgetUsd,
      budgetDuration: input.budgetDuration,
      tpmLimit: input.tpmLimit,
      rpmLimit: input.rpmLimit,
    });
  }

  const res = await gatewayRequest(config, keyGenerateUrl(config.baseUrl), {
    method: "POST",
    body: {
      key_alias: alias,
      metadata: { business_id: input.businessId, source: "cafe-pos" },
      ...limits,
    },
  });
  if (!ok(res.status)) {
    const error = asError(res.status);
    throw new Error(error.code);
  }
  const key = parseGeneratedKey(res.body);
  if (!key) throw new Error("ai_gateway_bad_response");
  return storeVirtualKey({
    businessId: input.businessId,
    virtualKey: key,
    keyAlias: alias,
    maxBudgetUsd: input.maxBudgetUsd,
    budgetDuration: input.budgetDuration,
    tpmLimit: input.tpmLimit,
    rpmLimit: input.rpmLimit,
  });
}

/** Revoke a business's virtual key at the gateway and drop the row. */
export async function revokeVirtualKey(
  config: AiGatewayConfig,
  businessId: string,
): Promise<void> {
  const existing = await getBusinessGatewayOrEmpty(businessId);
  if (existing?.virtualKey) {
    await gatewayRequest(config, keyDeleteUrl(config.baseUrl), {
      method: "POST",
      body: { keys: [existing.virtualKey] },
    });
  }
  await clearVirtualKey(businessId);
}

/**
 * Ask the gateway what this key has spent. Diagnostic only — the figure the
 * business is billed remains the Rial ledger.
 */
export async function refreshKeySpend(
  config: AiGatewayConfig,
  businessId: string,
): Promise<BusinessGateway | null> {
  const existing = await getBusinessGatewayOrEmpty(businessId);
  if (!existing?.virtualKey) return existing ?? null;
  const res = await gatewayRequest(config, keyInfoUrl(config.baseUrl, existing.virtualKey), { method: "GET" });
  const spend = ok(res.status) ? parseKeySpend(res.body) : null;
  if (!spend) return existing;
  await withoutTenantScope("platform", async () => {
    await query(
      `UPDATE ai_business_gateway
          SET spend_usd = $2, updated_at = now()
        WHERE business_id = $1`,
      [businessId, spend.spendUsd],
    );
  });
  return (await getBusinessGateway(businessId)) ?? existing;
}

/** Platform-scoped read used by the provisioning path before a write. */
async function getBusinessGatewayOrEmpty(businessId: string): Promise<BusinessGateway | null> {
  return withoutTenantScope("platform", () => getBusinessGateway(businessId));
}

// ---------------------------------------------------------------------------
// Phase 38b — costing resolution and usage sync
//
// The costing helper is called on every settlement path, so it fails soft and
// returns null on anything unexpected: a turn that would have settled on the
// token rates must keep settling on them, not fail because the gateway row
// is unreadable. The sync is an explicit operator action and is allowed to
// report failure loudly in its result object.
// ---------------------------------------------------------------------------

/** Gateway costing in force right now, or null when turns settle on the token rates. */
export interface GatewayCosting {
  usdRialRate: number;
}

/**
 * The costing policy for settlements: the platform's cost source is the
 * gateway only when the platform runs through it, the switch is on, and a
 * USD→Rial rate is configured. Anything else is null — the exact precedence
 * the runtime uses before attaching gateway fields to a call.
 */
export async function resolveGatewayCosting(): Promise<GatewayCosting | null> {
  try {
    const gateway = await getAiGatewayConfig();
    if (!gateway.gatewayCostingEnabled || !gateway.usdRialRate) return null;
    return { usdRialRate: gateway.usdRialRate };
  } catch (err) {
    console.error("ai gateway costing unavailable; settling on the token rates", err);
    return null;
  }
}

/**
 * The settlement figures for one turn the gateway priced: USD in, Rial out
 * (cost plus the platform's margin). Null whenever there is nothing to
 * price from — no reported cost, costing off, or a conversion that lands at
 * zero — which the caller reads as "use the token rates", never as free.
 */
export async function resolveGatewayTurnPricing(
  costUsd: number | null | undefined,
  marginPercent: number,
): Promise<AiGatewayTurnPricing | null> {
  if (costUsd === null || costUsd === undefined || !(costUsd > 0)) return null;
  const costing = await resolveGatewayCosting();
  if (!costing) return null;
  const { costRial, chargedRial } = gatewayTurnPricing(costUsd, costing.usdRialRate, marginPercent);
  if (chargedRial <= 0) return null;
  return { costUsd, costRial, chargedRial };
}

type UsageRollupRow = {
  id: string;
  day: string;
  key_alias: string;
  business_id: string | null;
  model: string;
  spend_usd: string | number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  api_requests: number;
};

export interface GatewayUsageEntry {
  day: string;
  keyAlias: string;
  businessId: string | null;
  model: string;
  spendUsd: number;
  promptTokens: number;
  completionTokens: number;
  apiRequests: number;
}

function rowToUsageEntry(row: UsageRollupRow): GatewayUsageEntry {
  return {
    day: typeof row.day === "string" ? row.day.slice(0, 10) : String(row.day).slice(0, 10),
    keyAlias: row.key_alias,
    businessId: row.business_id,
    model: row.model,
    spendUsd: numberValue(row.spend_usd),
    promptTokens: numberValue(row.prompt_tokens),
    completionTokens: numberValue(row.completion_tokens),
    apiRequests: numberValue(row.api_requests),
  };
}

/** Stored rollups for a day window. Platform scope; the console reads it. */
export async function listGatewayUsage(options: { fromDay: string; toDay: string }): Promise<GatewayUsageEntry[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<UsageRollupRow>(
      `SELECT id, day, key_alias, business_id, model, spend_usd,
              prompt_tokens, completion_tokens, api_requests
         FROM ai_gateway_usage
        WHERE day BETWEEN $1 AND $2
        ORDER BY day DESC, key_alias, model`,
      [options.fromDay, options.toDay],
    ),
  );
  return rows.map(rowToUsageEntry);
}

/**
 * This business's own rollups, read under the ambient tenant scope: RLS
 * confines the read to the session's business, so the settings page can show
 * usage without a platform bypass.
 */
export async function listBusinessGatewayUsage(options: {
  fromDay: string;
  toDay: string;
}): Promise<GatewayUsageEntry[]> {
  const { rows } = await query<UsageRollupRow>(
    `SELECT id, day, key_alias, business_id, model, spend_usd,
            prompt_tokens, completion_tokens, api_requests
       FROM ai_gateway_usage
      WHERE day BETWEEN $1 AND $2
      ORDER BY day DESC, model`,
    [options.fromDay, options.toDay],
  );
  return rows.map(rowToUsageEntry);
}

export interface GatewayUsageSyncResult {
  ok: boolean;
  /** Wall-clock milliseconds for the whole pull-aggregate-store pass. */
  durationMs: number;
  /** Spend-log entries the gateway returned for the window. */
  entries: number;
  /** Rollup rows written (upserted) — zero when the gateway said nothing. */
  rows: number;
  /** A short, human-readable failure reason — Persian, shown in the console. */
  error: string | null;
}

/** UTC day N days ago, as the spend-log window's inclusive start. */
function utcDayNDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

/**
 * Pull the proxy's spend logs for the last `days` days, aggregate them into
 * the daily rollup, and store them.
 *
 * Two deliberate properties. The window always starts `days` ago and ends
 * *tomorrow*: the proxy logs in UTC while an operator presses the button at
 * any hour, so the rolling window re-reads recent days rather than
 * maintaining a cursor that could silently stop advancing. And the write is
 * an upsert — re-syncing a day replaces its rows in place, so a partial
 * gateway log followed by a complete one converges instead of double
 * counting.
 */
export async function syncGatewayUsage(
  config: AiGatewayConfig,
  options: { days?: number } = {},
): Promise<GatewayUsageSyncResult> {
  const started = Date.now();
  const days = Number.isSafeInteger(options.days) && (options.days ?? 0) > 0 ? (options.days as number) : 7;
  const failure = (error: string): GatewayUsageSyncResult => ({
    ok: false,
    durationMs: Date.now() - started,
    entries: 0,
    rows: 0,
    error,
  });

  if (!config.masterKey) return failure("کلید مدیر دروازه تنظیم نشده است؛ همگام‌سازی مصرف ممکن نشد.");
  const startDate = `${utcDayNDaysAgo(days)}T00:00:00`;
  const endDate = `${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T23:59:59`;
  const res = await gatewayRequest(config, spendLogsUrl(config.baseUrl, startDate, endDate), { method: "GET" });
  if (res.status === 0) return failure("دروازه در دسترس نیست (اتصال برقرار نشد).");
  if (res.status === 401 || res.status === 403) return failure(gatewayStatusMessage(res.status));
  if (res.status < 200 || res.status >= 300) return failure(gatewayStatusMessage(res.status));

  const entries = parseSpendLogs(res.body);
  const rollups = aggregateSpendLogs(entries);

  // Alias → business: the app mints aliases itself (`pos-<id sans dashes>`),
  // so the mapping resolves without asking the gateway.
  const businessRows = await withoutTenantScope("platform", () =>
    query<{ key_alias: string | null; business_id: string }>(
      `SELECT key_alias, business_id FROM ai_business_gateway WHERE key_alias IS NOT NULL`,
    ),
  );
  const aliasToBusiness = new Map<string, string>();
  for (const row of businessRows.rows) {
    if (row.key_alias) aliasToBusiness.set(row.key_alias, row.business_id);
  }

  let stored = 0;
  if (rollups.length > 0) {
    await withoutTenantScope("platform", async () => {
      for (const rollup of rollups) {
        await query(
          `INSERT INTO ai_gateway_usage
             (day, key_alias, business_id, model, spend_usd,
              prompt_tokens, completion_tokens, api_requests, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (day, key_alias, model)
           DO UPDATE SET business_id = EXCLUDED.business_id,
                         spend_usd = EXCLUDED.spend_usd,
                         prompt_tokens = EXCLUDED.prompt_tokens,
                         completion_tokens = EXCLUDED.completion_tokens,
                         api_requests = EXCLUDED.api_requests,
                         updated_at = now()`,
          [
            rollup.day,
            rollup.keyAlias,
            aliasToBusiness.get(rollup.keyAlias) ?? null,
            rollup.model,
            rollup.spendUsd,
            rollup.promptTokens,
            rollup.completionTokens,
            rollup.apiRequests,
          ],
        );
        stored += 1;
      }
    });
  }

  // The per-key cumulative spend (`ai_business_gateway.spend_usd`) is
  // deliberately NOT touched here: it is a lifetime figure from /key/info,
  // and this function only ever sees a rolling window. Mixing the two would
  // quietly rewrite a cumulative diagnostic with a weekly one.

  return { ok: true, durationMs: Date.now() - started, entries: entries.length, rows: stored, error: null };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Join a business's gateway row to the model its calls will actually use. */
export function toPublicBusinessGateway(
  business: BusinessGateway,
  config: AiGatewayConfig,
  platformModel: string,
): PublicBusinessGateway {
  const { virtualKey: _virtualKey, ...rest } = business;
  return {
    ...rest,
    hasVirtualKey: Boolean(business.virtualKey),
    effectiveModel: resolveChatModel({ platformModel, gateway: config, business }),
  };
}

export { defaultGatewayConfig, envGatewayConfig };
export type { AiGatewayConfig, BusinessGateway, GatewayProbe };
