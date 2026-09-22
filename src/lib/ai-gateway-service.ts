/**
 * Phase 37 & Phase 39 — the gateway's server half: the singleton gateway row,
 * each business and branch's slice of it, and the calls to the gateway's own management API.
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
 *    takes explicit `business_id` and optional `location_id` and writes through the
 *    ordinary `query()`, exactly as Phase 18's credit writes do: from the platform
 *    console the ambient scope is the documented `platform` bypass and any
 *    business/branch may be addressed, while from a business's own settings page RLS
 *    confines the write to the session's business — so a forged business id is
 *    refused rather than merely ignored.
 */
import { query, withoutTenantScope } from "./db";
import {
  defaultGatewayConfig,
  gatewayTurnPricing,
  emptyBusinessGateway,
  gatewayManagementUrl,
  gatewayStatusMessage,
  joinGatewayDetail,
  keyDeleteUrl,
  keyGenerateUrl,
  keyInfoUrl,
  keyUpdateUrl,
  livelinessUrl,
  modelInfoUrl,
  normalizeMcpServers,
  parseGatewayErrorDetail,
  parseGatewayModels,
  parseGeneratedKey,
  parseKeySpend,
  resolveChatModel,
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
  type PublicAiGatewayConfig,
  type PublicBusinessGateway,
  type AiGatewayTurnPricing,
} from "./ai-gateway";
import { getPlatformAiConfig } from "./ai-config";

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
  virtual_keys_enabled: boolean;
  allow_business_models: boolean;
  published_models: unknown;
  usd_rial_rate: string | null;
  gateway_costing_enabled: boolean;
  input_cost_rial_per_million: string | number;
  output_cost_rial_per_million: string | number;
  revenue_margin_percent: string | number | null;
  max_turn_rial: string | number | null;
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
    virtualKeysEnabled: row.virtual_keys_enabled,
    allowBusinessModels: row.allow_business_models,
    publishedModels: toStringList(row.published_models),
    usdRialRate: optionalNumber(row.usd_rial_rate),
    gatewayCostingEnabled: row.gateway_costing_enabled,
    inputCostRialPerMillion: numberValue(row.input_cost_rial_per_million),
    outputCostRialPerMillion: numberValue(row.output_cost_rial_per_million),
    revenueMarginPercent: Math.max(0, numberValue(row.revenue_margin_percent)),
    maxTurnRial: Math.max(0, numberValue(row.max_turn_rial)),
    mcpEnabled: row.mcp_enabled,
    mcpServers: normalizeMcpServers(row.mcp_servers),
  };
}

/** The gateway settings, or a switched-off default when the row has never been written. */
export async function getAiGatewayConfig(): Promise<AiGatewayConfig> {
  const { rows } = await query<GatewayRow>(
    `SELECT enabled, base_url, master_key, chat_model, embedding_model,
            fallback_models, virtual_keys_enabled,
            allow_business_models, published_models,
            usd_rial_rate, gateway_costing_enabled,
            input_cost_rial_per_million, output_cost_rial_per_million,
            revenue_margin_percent, max_turn_rial,
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
  const usdRate = Number(env.LITELLM_USD_RIAL_RATE ?? "");
  return {
    enabled: env.LITELLM_ENABLED === "true",
    baseUrl: env.LITELLM_BASE_URL?.trim() || undefined,
    masterKey: env.LITELLM_MASTER_KEY?.trim() || undefined,
    chatModel: env.LITELLM_CHAT_MODEL?.trim() || undefined,
    embeddingModel: env.LITELLM_EMBEDDING_MODEL?.trim() || undefined,
    fallbackModels: env.LITELLM_FALLBACK_MODELS ? env.LITELLM_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean) : undefined,
    usdRialRate: Number.isFinite(usdRate) && usdRate > 0 ? usdRate : null,
  };
}

/**
 * Overlay a partial draft onto the stored settings.
 */
export function mergeGatewayConfig(draft: AiGatewayInput, current: AiGatewayConfig): AiGatewayConfig {
  return {
    enabled: draft.enabled ?? current.enabled,
    baseUrl: (draft.baseUrl ?? current.baseUrl).trim() || current.baseUrl,
    masterKey: draft.masterKey?.trim() || current.masterKey,
    chatModel: draft.chatModel ?? current.chatModel,
    embeddingModel: draft.embeddingModel ?? current.embeddingModel,
    fallbackModels: draft.fallbackModels === undefined ? current.fallbackModels : toStringList(draft.fallbackModels),
    virtualKeysEnabled: draft.virtualKeysEnabled ?? current.virtualKeysEnabled,
    allowBusinessModels: draft.allowBusinessModels ?? current.allowBusinessModels,
    publishedModels:
      draft.publishedModels === undefined ? current.publishedModels : toStringList(draft.publishedModels),
    usdRialRate: pickOptionalNumber(draft.usdRialRate, current.usdRialRate),
    gatewayCostingEnabled: draft.gatewayCostingEnabled ?? current.gatewayCostingEnabled,
    inputCostRialPerMillion: pickNonNegativeNumber(draft.inputCostRialPerMillion, current.inputCostRialPerMillion),
    outputCostRialPerMillion: pickNonNegativeNumber(draft.outputCostRialPerMillion, current.outputCostRialPerMillion),
    revenueMarginPercent: pickNonNegativeNumber(draft.revenueMarginPercent, current.revenueMarginPercent),
    maxTurnRial: pickNonNegativeNumber(draft.maxTurnRial, current.maxTurnRial),
    mcpEnabled: draft.mcpEnabled ?? current.mcpEnabled,
    mcpServers: draft.mcpServers === undefined ? current.mcpServers : normalizeMcpServers(draft.mcpServers),
  };
}

function pickOptionalNumber(value: number | null | undefined, current: number | null): number | null {
  if (value === undefined) return current;
  return optionalNumber(value);
}

/** A non-negative numeric setting (margin, ceiling): 0 is valid, negatives clamp to current. */
function pickNonNegativeNumber(value: number | null | undefined, current: number): number {
  if (value === undefined || value === null) return current;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : current;
}

/**
 * Persist the gateway settings.
 */
export async function saveAiGatewayConfig(input: AiGatewayInput): Promise<AiGatewayConfig> {
  const current = await getAiGatewayConfig();
  // Validate the complete state that will be persisted, not a partial patch.
  // This lets later edits omit unchanged fields while still preventing an
  // enabled configuration that runtime would immediately reject.
  const errors = validateGatewayInput(mergeGatewayConfig(input, current));
  if (errors.length > 0) throw new Error(errors[0]);
  const masterKey = input.masterKey?.trim() || current.masterKey || null;
  await query(
    `INSERT INTO platform_ai_gateway
       (id, enabled, base_url, master_key, chat_model, embedding_model,
        fallback_models, virtual_keys_enabled,
        allow_business_models, published_models,
        usd_rial_rate, gateway_costing_enabled, input_cost_rial_per_million, output_cost_rial_per_million,
        revenue_margin_percent, max_turn_rial,
        mcp_enabled, mcp_servers, updated_at)
     VALUES
       (true, $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb,
        $10, $11, $12, $13, $14, $15, $16, $17::jsonb, now())
     ON CONFLICT (id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   base_url = EXCLUDED.base_url,
                   master_key = EXCLUDED.master_key,
                   chat_model = EXCLUDED.chat_model,
                   embedding_model = EXCLUDED.embedding_model,
                   fallback_models = EXCLUDED.fallback_models,
                   virtual_keys_enabled = EXCLUDED.virtual_keys_enabled,
                   allow_business_models = EXCLUDED.allow_business_models,
                   published_models = EXCLUDED.published_models,
                   usd_rial_rate = EXCLUDED.usd_rial_rate,
                   gateway_costing_enabled = EXCLUDED.gateway_costing_enabled,
                   input_cost_rial_per_million = EXCLUDED.input_cost_rial_per_million,
                   output_cost_rial_per_million = EXCLUDED.output_cost_rial_per_million,
                   revenue_margin_percent = EXCLUDED.revenue_margin_percent,
                   max_turn_rial = EXCLUDED.max_turn_rial,
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
      input.virtualKeysEnabled ?? current.virtualKeysEnabled,
      input.allowBusinessModels ?? current.allowBusinessModels,
      JSON.stringify(toStringList(input.publishedModels ?? current.publishedModels)),
      pickOptionalNumber(input.usdRialRate, current.usdRialRate),
      input.gatewayCostingEnabled ?? current.gatewayCostingEnabled,
      pickNonNegativeNumber(input.inputCostRialPerMillion, current.inputCostRialPerMillion),
      pickNonNegativeNumber(input.outputCostRialPerMillion, current.outputCostRialPerMillion),
      pickNonNegativeNumber(input.revenueMarginPercent, current.revenueMarginPercent),
      Math.round(pickNonNegativeNumber(input.maxTurnRial, current.maxTurnRial)),
      input.mcpEnabled ?? current.mcpEnabled,
      JSON.stringify(
        input.mcpServers === undefined ? current.mcpServers : normalizeMcpServers(input.mcpServers),
      ),
    ],
  );
  return getAiGatewayConfig();
}

// ---------------------------------------------------------------------------
// Business & Branch Gateways
// ---------------------------------------------------------------------------

type BusinessGatewayRow = {
  id?: string;
  business_id: string;
  location_id: string | null;
  virtual_key: string | null;
  key_alias: string | null;
  model_override: string | null;
  spend_usd: string | null;
  synced_at: string | null;
  sync_error: string | null;
};

function rowToBusinessGateway(row: BusinessGatewayRow): BusinessGateway {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id ?? null,
    virtualKey: row.virtual_key ?? null,
    keyAlias: row.key_alias ?? null,
    modelOverride: row.model_override ?? null,
    spendUsd: numberValue(row.spend_usd),
    syncedAt: row.synced_at,
    syncError: row.sync_error ?? null,
  };
}

/**
 * Get gateway row for a business or a specific branch.
 * If locationId is provided, queries for that branch.
 * If locationId is null/undefined, queries for the business-level gateway (location_id IS NULL).
 */
export async function getBusinessGateway(
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway | null> {
  const loc = locationId?.trim() || null;
  const { rows } = await query<BusinessGatewayRow>(
    `SELECT id, business_id, location_id, virtual_key, key_alias, model_override,
            spend_usd, synced_at, sync_error
       FROM ai_business_gateway
      WHERE business_id = $1
        AND (
          ($2::uuid IS NOT NULL AND location_id = $2::uuid)
          OR
          ($2::uuid IS NULL AND location_id IS NULL)
        )`,
    [businessId, loc],
  );
  return rows[0] ? rowToBusinessGateway(rows[0]) : null;
}

/** Get gateway row for a specific branch. */
export async function getBranchGateway(
  businessId: string,
  locationId: string,
): Promise<BusinessGateway | null> {
  return getBusinessGateway(businessId, locationId);
}

/** List all branch gateways for a business. */
export async function listBranchGateways(businessId: string): Promise<BusinessGateway[]> {
  const { rows } = await query<BusinessGatewayRow>(
    `SELECT id, business_id, location_id, virtual_key, key_alias, model_override,
            spend_usd, synced_at, sync_error
       FROM ai_business_gateway
      WHERE business_id = $1
        AND location_id IS NOT NULL`,
    [businessId],
  );
  return rows.map(rowToBusinessGateway);
}

/** List business/branch gateway rows. Platform scope. */
export async function listBusinessGateways(
  businessId?: string,
  locationId?: string | null,
): Promise<BusinessGateway[]> {
  return withoutTenantScope("platform", async () => {
    let sql = `SELECT id, business_id, location_id, virtual_key, key_alias, model_override,
                      spend_usd, synced_at, sync_error
                 FROM ai_business_gateway`;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (businessId) {
      params.push(businessId);
      conditions.push(`business_id = $${params.length}`);
    }

    if (locationId !== undefined) {
      if (locationId === null) {
        conditions.push(`location_id IS NULL`);
      } else {
        params.push(locationId);
        conditions.push(`location_id = $${params.length}`);
      }
    }

    if (conditions.length > 0) {
      sql += ` WHERE ` + conditions.join(" AND ");
    }

    sql += ` ORDER BY business_id, location_id NULLS FIRST`;
    const { rows } = await query<BusinessGatewayRow>(sql, params);
    return rows.map(rowToBusinessGateway);
  });
}

/**
 * Upsert gateway settings for a business or branch.
 */
export async function saveBusinessGateway(
  businessId: string,
  input: BusinessGatewayInput,
  gateway: AiGatewayConfig,
  locationId?: string | null,
): Promise<BusinessGateway> {
  const loc = locationId?.trim() || null;
  const errors = validateBusinessGatewayInput(input, {
    allowBusinessModels: gateway.allowBusinessModels,
    allowedModels: gateway.publishedModels,
  });
  if (errors.length > 0) throw new Error(errors[0]);

  await query(
    `INSERT INTO ai_business_gateway
       (business_id, location_id, model_override, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (business_id, location_id)
     DO UPDATE SET model_override = EXCLUDED.model_override,
                   updated_at = now()`,
    [
      businessId,
      loc,
      input.modelOverride === undefined ? null : (input.modelOverride ?? "").trim() || null,
    ],
  );
  return (await getBusinessGateway(businessId, loc)) ?? emptyBusinessGateway(businessId, loc);
}

/** Record a virtual key against a business or branch. Platform scope. */
async function storeVirtualKey(input: {
  businessId: string;
  locationId?: string | null;
  virtualKey: string;
  keyAlias: string;
  syncError?: string | null;
}): Promise<BusinessGateway> {
  const loc = input.locationId?.trim() || null;
  return withoutTenantScope("platform", async () => {
    await query(
      `INSERT INTO ai_business_gateway
         (business_id, location_id, virtual_key, key_alias, synced_at, sync_error, updated_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5::text IS NULL THEN now() ELSE NULL END, $5, now())
       ON CONFLICT (business_id, location_id)
       DO UPDATE SET virtual_key = EXCLUDED.virtual_key,
                     key_alias = EXCLUDED.key_alias,
                     synced_at = CASE WHEN $5::text IS NULL THEN now() ELSE ai_business_gateway.synced_at END,
                     sync_error = EXCLUDED.sync_error,
                     updated_at = now()`,
      [
        input.businessId,
        loc,
        input.virtualKey,
        input.keyAlias,
        input.syncError ?? null,
      ],
    );
    return (await getBusinessGateway(input.businessId, loc)) ?? emptyBusinessGateway(input.businessId, loc);
  });
}

/** Forget the virtual key and the row that held it. Platform scope. */
export async function clearVirtualKey(businessId: string, locationId?: string | null): Promise<void> {
  const loc = locationId?.trim() || null;
  await withoutTenantScope("platform", async () => {
    await query(
      `DELETE FROM ai_business_gateway
        WHERE business_id = $1
          AND (
            ($2::uuid IS NOT NULL AND location_id = $2::uuid)
            OR
            ($2::uuid IS NULL AND location_id IS NULL)
          )`,
      [businessId, loc],
    );
  });
}

// ---------------------------------------------------------------------------
// The gateway's own management API
// ---------------------------------------------------------------------------

interface GatewayResponse {
  status: number;
  body: unknown;
}

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
  /** The proxy's own explanation of the failure, when it sent one. */
  detail: string | null;
}

function asError(status: number, body?: unknown): GatewayCallError {
  if (status === 0) {
    return {
      code: "ai_gateway_unreachable",
      message: "دروازه در دسترس نیست (اتصال برقرار نشد).",
      detail: null,
    };
  }
  return {
    code: status === 401 || status === 403 ? "ai_gateway_auth" : "ai_gateway_error",
    message: gatewayStatusMessage(status),
    detail: parseGatewayErrorDetail(body),
  };
}

/**
 * The one throw of this module: provisioning is an explicit operator action,
 * so the operator is entitled to the code *and* the proxy's own explanation.
 * `message` stays the code so the route's `startsWith("ai_gateway")` contract
 * keeps working; the explanation rides along as `detail`.
 */
export class GatewayProvisioningError extends Error {
  readonly code: string;
  readonly detail: string | null;

  constructor(code: string, detail: string | null) {
    super(code);
    this.name = "GatewayProvisioningError";
    this.code = code;
    this.detail = detail;
  }
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Liveness plus the model list — the console's "test connection" button. */
export async function probeGateway(config: AiGatewayConfig): Promise<GatewayProbe> {
  const started = Date.now();
  const health = await gatewayRequest(config, livelinessUrl(config.baseUrl), { method: "GET" });
  if (!ok(health.status)) {
    const error = asError(health.status, health.body);
    return {
      ok: false,
      latencyMs: null,
      models: [],
      error: joinGatewayDetail(error.message, error.detail),
    };
  }
  const latencyMs = Date.now() - started;
  const models = config.masterKey ? await listGatewayModels(config) : [];
  return {
    ok: true,
    latencyMs,
    models,
    error: null,
  };
}

/** Model aliases the gateway is serving. Empty when the admin key is absent. */
export async function listGatewayModels(config: AiGatewayConfig): Promise<string[]> {
  if (!config.masterKey) return [];
  const res = await gatewayRequest(config, modelInfoUrl(config.baseUrl), { method: "GET" });
  return ok(res.status) ? parseGatewayModels(res.body) : [];
}

export interface VirtualKeyInput {
  businessId: string;
  locationId?: string | null;
}

/**
 * Mint (or refresh) the virtual key for one business or branch and store it.
 *
 * Single-architecture rule (migration 0168): the minted key is an IDENTITY —
 * it carries the alias and business metadata and nothing else. No `models`
 * allowlist (changing the platform's chat alias would otherwise orphan every
 * existing key against the new model), and no max_budget / budget_duration /
 * tpm_limit / rpm_limit (those are LiteLLM's to enforce; a mirrored key budget
 * used to 429 tenants whose platform wallet still had credit). The platform
 * gate — wallet affordability — is the only billing stop on the request path.
 */
export async function provisionVirtualKey(
  config: AiGatewayConfig,
  input: VirtualKeyInput,
): Promise<BusinessGateway> {
  const loc = input.locationId?.trim() || null;
  const alias = virtualKeyAlias(input.businessId, loc);
  const existing = await getBusinessGatewayOrEmpty(input.businessId, loc);

  if (existing?.virtualKey) {
    const res = await gatewayRequest(config, keyUpdateUrl(config.baseUrl), {
      method: "POST",
      // Only the identity metadata is refreshed; the key keeps whatever the
      // proxy itself enforces on it.
      body: { key: existing.virtualKey, key_alias: alias },
    });
    if (!ok(res.status)) {
      const error = asError(res.status, res.body);
      return storeVirtualKey({
        businessId: input.businessId,
        locationId: loc,
        virtualKey: existing.virtualKey,
        keyAlias: alias,
        syncError: joinGatewayDetail(error.message, error.detail),
      });
    }
    return storeVirtualKey({
      businessId: input.businessId,
      locationId: loc,
      virtualKey: existing.virtualKey,
      keyAlias: alias,
    });
  }

  const res = await gatewayRequest(config, keyGenerateUrl(config.baseUrl), {
    method: "POST",
    body: {
      key_alias: alias,
      metadata: {
        business_id: input.businessId,
        ...(loc ? { location_id: loc } : {}),
        source: "cafe-pos",
      },
    },
  });
  if (!ok(res.status)) {
    const error = asError(res.status, res.body);
    throw new GatewayProvisioningError(error.code, error.detail);
  }
  const key = parseGeneratedKey(res.body);
  if (!key) {
    throw new GatewayProvisioningError("ai_gateway_bad_response", parseGatewayErrorDetail(res.body));
  }
  return storeVirtualKey({
    businessId: input.businessId,
    locationId: loc,
    virtualKey: key,
    keyAlias: alias,
  });
}

/**
 * Provision the business-level key immediately after a business is created.
 *
 * Business creation must not be rolled back when LiteLLM is temporarily down:
 * the gateway can be restarted and the admin can retry from the console. When
 * it is configured, however, a new tenant is ready for AI before the create
 * request returns — there is no second manual "generate key" step.
 */
export async function autoProvisionBusinessVirtualKey(businessId: string): Promise<BusinessGateway | null> {
  try {
    const [gateway] = await Promise.all([getAiGatewayConfig(), getPlatformAiConfig()]);
    if (!gateway.virtualKeysEnabled || !gateway.masterKey || !gateway.enabled) return null;

    return await provisionVirtualKey(gateway, {
      businessId,
      locationId: null,
    });
  } catch (error) {
    const syncError = error instanceof Error ? error.message : "ai_gateway_provision_failed";
    // Keep a visible retryable record without exposing the master key or
    // making tenant creation depend on gateway availability.
    try {
      await withoutTenantScope("platform", async () => {
        await query(
          `INSERT INTO ai_business_gateway
             (business_id, location_id, sync_error, updated_at)
           VALUES ($1, NULL, $2, now())
           ON CONFLICT (business_id, location_id)
           DO UPDATE SET sync_error = EXCLUDED.sync_error, updated_at = now()`,
          [businessId, syncError],
        );
      });
    } catch (recordError) {
      console.error("could not record automatic LiteLLM key provisioning failure", recordError);
    }
    console.error("automatic LiteLLM key provisioning failed", { businessId, error: syncError });
    return null;
  }
}

/**
 * Lazily guarantee a business's virtual key on the REQUEST path (the root
 * cause fix for "کلید مجازی این کسب‌وکار صادر نشده است" reaching tenants).
 *
 * A tenant whose key was never minted — created while the gateway was down, or
 * before virtual keys were switched on — used to be refused with
 * `tenant_virtual_key_missing` until an operator noticed. Now the first
 * request mints the key itself: the platform console's per-business readiness
 * read stays a read (it must not mint N keys in one page load), but the
 * request path, which is about to authenticate as this business, may.
 *
 * Failure here is never a hard error: the provisioning attempt is recorded on
 * the row (sync_error) and the turn fails closed exactly as before. A
 * per-process, per-business cooldown keeps a down gateway from adding a 10s
 * management call to every chat turn.
 */
const ensureKeyCooldownMs = 60_000;
const ensureKeyFailures = new Map<string, number>();

export async function ensureTenantVirtualKey(
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway | null> {
  const scope = locationId ? `${businessId}:${locationId}` : businessId;
  const existing = await getBusinessGateway(businessId, locationId ?? null);
  if (existing?.virtualKey) return existing;

  const lastFailure = ensureKeyFailures.get(scope);
  if (lastFailure !== undefined && Date.now() - lastFailure < ensureKeyCooldownMs) return existing;

  const gateway = await getAiGatewayConfig();
  if (!gateway.enabled || !gateway.virtualKeysEnabled || !gateway.masterKey) return existing;

  try {
    const row = await provisionVirtualKey(gateway, { businessId, locationId: locationId ?? null });
    ensureKeyFailures.delete(scope);
    return row;
  } catch (error) {
    ensureKeyFailures.set(scope, Date.now());
    console.error("lazy tenant virtual key provisioning failed", {
      businessId,
      locationId: locationId ?? null,
      error: error instanceof Error ? error.message : error,
    });
    return existing;
  }
}

/** Revoke a business or branch's virtual key at the gateway and drop the row. */
export async function revokeVirtualKey(
  config: AiGatewayConfig,
  businessId: string,
  locationId?: string | null,
): Promise<void> {
  const loc = locationId?.trim() || null;
  const existing = await getBusinessGatewayOrEmpty(businessId, loc);
  if (existing?.virtualKey) {
    await gatewayRequest(config, keyDeleteUrl(config.baseUrl), {
      method: "POST",
      body: { keys: [existing.virtualKey] },
    });
  }
  await clearVirtualKey(businessId, loc);
}

/**
 * Ask the gateway what this key has spent. Diagnostic only.
 */
export async function refreshKeySpend(
  config: AiGatewayConfig,
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway | null> {
  const loc = locationId?.trim() || null;
  const existing = await getBusinessGatewayOrEmpty(businessId, loc);
  if (!existing?.virtualKey) return existing ?? null;
  const res = await gatewayRequest(config, keyInfoUrl(config.baseUrl, existing.virtualKey), { method: "GET" });
  const spend = ok(res.status) ? parseKeySpend(res.body) : null;
  if (!spend) return existing;
  await withoutTenantScope("platform", async () => {
    await query(
      `UPDATE ai_business_gateway
          SET spend_usd = $3, updated_at = now()
        WHERE business_id = $1
          AND (
            ($2::uuid IS NOT NULL AND location_id = $2::uuid)
            OR
            ($2::uuid IS NULL AND location_id IS NULL)
          )`,
      [businessId, loc, spend.spendUsd],
    );
  });
  return (await getBusinessGateway(businessId, loc)) ?? existing;
}

/** Platform-scoped read used by the provisioning path before a write. */
async function getBusinessGatewayOrEmpty(
  businessId: string,
  locationId?: string | null,
): Promise<BusinessGateway | null> {
  return withoutTenantScope("platform", () => getBusinessGateway(businessId, locationId));
}

// ---------------------------------------------------------------------------
// Costing resolution (settlement support for the billing ledger)
// ---------------------------------------------------------------------------

export interface GatewayCosting {
  usdRialRate: number;
}

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

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/** Join a business or branch's gateway row to the model its calls will actually use. */
export function toPublicBusinessGateway(
  business: BusinessGateway,
  config: AiGatewayConfig,
  platformModel: string,
): PublicBusinessGateway {
  const { virtualKey: _virtualKey, ...rest } = business;
  return {
    ...rest,
    hasVirtualKey: Boolean(business.virtualKey),
    effectiveModel: resolveChatModel({
      platformModel,
      gateway: config,
      business: business.locationId ? null : business,
      branch: business.locationId ? business : null,
    }),
  };
}

export { defaultGatewayConfig, envGatewayConfig };
export type { AiGatewayConfig, BusinessGateway, GatewayProbe };
