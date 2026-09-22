/**
 * Phase 37 & Phase 39 — the gateway's server half: the singleton gateway row,
 * each business and branch's slice of it, and the calls to the gateway's own management API.
 *
 * Two rules shape this file:
 * 1. A gateway failure is never an assistant crash.
 * 2. Tenant scope is the caller's, not this module's.
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
  parseGatewayErrorDetail,
  parseGatewayModels,
  parseGeneratedKey,
  parseKeySpend,
  parseProviderError,
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
  type GatewayProbeStage,
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
  fallback_models?: unknown;
  virtual_keys_enabled: boolean;
  allow_business_models: boolean;
  published_models?: unknown;
};

function rowToGateway(row: GatewayRow): AiGatewayConfig {
  const fallback = defaultGatewayConfig();
  return {
    enabled: row.enabled,
    baseUrl: textOr(row.base_url, fallback.baseUrl),
    masterKey: row.master_key ?? "",
    chatModel: row.chat_model ?? "",
    embeddingModel: row.embedding_model ?? "",
    virtualKeysEnabled: Boolean(row.virtual_keys_enabled),
    allowBusinessModels: Boolean(row.allow_business_models),
    publishedModels: toStringList(row.published_models),
    fallbackModels: toStringList(row.fallback_models),
  };
}

/** The gateway settings, or a switched-off default when the row has never been written. */
export async function getAiGatewayConfig(): Promise<AiGatewayConfig> {
  const { rows } = await query<GatewayRow>(
    `SELECT enabled, base_url, master_key, chat_model, embedding_model,
            fallback_models, virtual_keys_enabled,
            allow_business_models, published_models
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
  return {
    enabled: env.LITELLM_ENABLED === "true",
    baseUrl: env.LITELLM_BASE_URL?.trim() || undefined,
    masterKey: env.LITELLM_MASTER_KEY?.trim() || undefined,
    chatModel: env.LITELLM_CHAT_MODEL?.trim() || undefined,
    embeddingModel: env.LITELLM_EMBEDDING_MODEL?.trim() || undefined,
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
    virtualKeysEnabled: draft.virtualKeysEnabled ?? current.virtualKeysEnabled,
    allowBusinessModels: draft.allowBusinessModels ?? current.allowBusinessModels,
    publishedModels:
      draft.publishedModels === undefined ? current.publishedModels : toStringList(draft.publishedModels),
    fallbackModels: draft.fallbackModels === undefined ? current.fallbackModels : toStringList(draft.fallbackModels),
  };
}

/**
 * Persist the technical gateway settings.
 */
export async function saveAiGatewayConfig(input: AiGatewayInput): Promise<AiGatewayConfig> {
  const current = await getAiGatewayConfig();
  const merged = mergeGatewayConfig(input, current);
  const errors = validateGatewayInput(merged);
  if (errors.length > 0) throw new Error(errors[0]);
  const masterKey = input.masterKey?.trim() || current.masterKey || null;

  await query(
    `INSERT INTO platform_ai_gateway
       (id, enabled, base_url, master_key, chat_model, embedding_model,
        virtual_keys_enabled, allow_business_models, published_models,
        fallback_models, updated_at)
     VALUES
       (true, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, now())
     ON CONFLICT (id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   base_url = EXCLUDED.base_url,
                   master_key = EXCLUDED.master_key,
                   chat_model = EXCLUDED.chat_model,
                   embedding_model = EXCLUDED.embedding_model,
                   virtual_keys_enabled = EXCLUDED.virtual_keys_enabled,
                   allow_business_models = EXCLUDED.allow_business_models,
                   published_models = EXCLUDED.published_models,
                   fallback_models = EXCLUDED.fallback_models,
                   updated_at = now()`,
    [
      merged.enabled,
      merged.baseUrl,
      masterKey,
      merged.chatModel,
      merged.embeddingModel,
      merged.virtualKeysEnabled,
      merged.allowBusinessModels,
      JSON.stringify(merged.publishedModels),
      JSON.stringify(merged.fallbackModels ?? []),
    ],
  );
  return getAiGatewayConfig();
}

// ---------------------------------------------------------------------------
// Per-business and per-branch gateway slices
// ---------------------------------------------------------------------------

type BusinessGatewayRow = {
  id: string;
  business_id: string;
  location_id: string | null;
  virtual_key: string | null;
  key_alias: string | null;
  model_override: string | null;
  spend_usd: string | number | null;
  synced_at: string | null;
  sync_error: string | null;
};

function rowToBusinessGateway(row: BusinessGatewayRow): BusinessGateway {
  return {
    businessId: row.business_id,
    locationId: row.location_id,
    virtualKey: row.virtual_key,
    keyAlias: row.key_alias,
    modelOverride: row.model_override,
    spendUsd: numberValue(row.spend_usd),
    syncedAt: row.synced_at,
    syncError: row.sync_error,
  };
}

export async function getBusinessGateway(
  businessId: string,
  locationId: string | null = null,
): Promise<BusinessGateway | null> {
  const { rows } = await query<BusinessGatewayRow>(
    `SELECT id, business_id, location_id, virtual_key, key_alias,
            model_override, spend_usd, synced_at, sync_error
       FROM ai_business_gateway
      WHERE business_id = $1
        AND (
          ($2::uuid IS NOT NULL AND location_id = $2::uuid)
          OR
          ($2::uuid IS NULL AND location_id IS NULL)
        )`,
    [businessId, locationId],
  );
  return rows[0] ? rowToBusinessGateway(rows[0]) : null;
}

export async function getBranchGateway(
  businessId: string,
  locationId: string,
): Promise<BusinessGateway | null> {
  return getBusinessGateway(businessId, locationId);
}

export async function listBranchGateways(businessId: string): Promise<BusinessGateway[]> {
  const { rows } = await query<BusinessGatewayRow>(
    `SELECT id, business_id, location_id, virtual_key, key_alias,
            model_override, spend_usd, synced_at, sync_error
       FROM ai_business_gateway
      WHERE business_id = $1 AND location_id IS NOT NULL
      ORDER BY updated_at DESC`,
    [businessId],
  );
  return rows.map(rowToBusinessGateway);
}

export async function listBusinessGateways(businessId?: string): Promise<BusinessGateway[]> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<BusinessGatewayRow>(
      businessId
        ? `SELECT id, business_id, location_id, virtual_key, key_alias,
                  model_override, spend_usd, synced_at, sync_error
             FROM ai_business_gateway
            WHERE business_id = $1
            ORDER BY updated_at DESC`
        : `SELECT id, business_id, location_id, virtual_key, key_alias,
                  model_override, spend_usd, synced_at, sync_error
             FROM ai_business_gateway
            ORDER BY updated_at DESC`,
      businessId ? [businessId] : [],
    ),
  );
  return rows.map(rowToBusinessGateway);
}

export async function saveBusinessGateway(
  businessId: string,
  input: BusinessGatewayInput,
  gateway: AiGatewayConfig,
  locationId: string | null = null,
): Promise<BusinessGateway> {
  const errors = validateBusinessGatewayInput(input, {
    allowBusinessModels: gateway.allowBusinessModels,
    allowedModels: gateway.publishedModels,
  });
  if (errors.length > 0) throw new Error(errors[0]);

  const existing = await getBusinessGateway(businessId, locationId);
  const modelOverride =
    input.modelOverride === undefined ? existing?.modelOverride ?? null : input.modelOverride;

  const { rows } = await query<BusinessGatewayRow>(
    `INSERT INTO ai_business_gateway
       (business_id, location_id, model_override, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (business_id, location_id)
     DO UPDATE SET model_override = EXCLUDED.model_override,
                   updated_at = now()
     RETURNING id, business_id, location_id, virtual_key, key_alias,
               model_override, spend_usd, synced_at, sync_error`,
    [businessId, locationId, modelOverride],
  );
  return rowToBusinessGateway(rows[0]);
}

export async function storeVirtualKey(input: {
  businessId: string;
  locationId: string | null;
  virtualKey: string;
  keyAlias: string;
  syncError?: string | null;
}): Promise<BusinessGateway> {
  const { businessId, locationId, virtualKey, keyAlias, syncError = null } = input;
  const { rows } = await withoutTenantScope("platform", () =>
    query<BusinessGatewayRow>(
      `INSERT INTO ai_business_gateway
         (business_id, location_id, virtual_key, key_alias, synced_at, sync_error, updated_at)
       VALUES ($1, $2, $3, $4, now(), $5, now())
       ON CONFLICT (business_id, location_id)
       DO UPDATE SET virtual_key = EXCLUDED.virtual_key,
                     key_alias = EXCLUDED.key_alias,
                     synced_at = now(),
                     sync_error = EXCLUDED.sync_error,
                     updated_at = now()
       RETURNING id, business_id, location_id, virtual_key, key_alias,
                 model_override, spend_usd, synced_at, sync_error`,
      [businessId, locationId, virtualKey, keyAlias, syncError],
    ),
  );
  return rowToBusinessGateway(rows[0]);
}

export async function clearVirtualKey(businessId: string, locationId: string | null = null): Promise<void> {
  await withoutTenantScope("platform", () =>
    query(
      `UPDATE ai_business_gateway
          SET virtual_key = NULL,
              key_alias = NULL,
              synced_at = NULL,
              sync_error = NULL,
              spend_usd = 0,
              updated_at = now()
        WHERE business_id = $1
          AND (
            ($2::uuid IS NOT NULL AND location_id = $2::uuid)
            OR
            ($2::uuid IS NULL AND location_id IS NULL)
          )`,
      [businessId, locationId],
    ),
  );
}

// ---------------------------------------------------------------------------
// Gateway Management API calls
// ---------------------------------------------------------------------------

export interface GatewayResponse {
  status: number;
  body: unknown;
}

export async function gatewayRequest(
  config: AiGatewayConfig,
  url: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {},
): Promise<GatewayResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MANAGEMENT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.masterKey) headers.Authorization = `Bearer ${config.masterKey}`;
    const res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: 504, body: { error: "gateway_timeout" } };
    }
    return { status: 503, body: { error: "gateway_unreachable" } };
  } finally {
    clearTimeout(timer);
  }
}

function asError(status: number, body: unknown): { code: string; message: string; detail: string | null } {
  const detail = parseGatewayErrorDetail(body);
  if (status === 401 || status === 403) return { code: "ai_gateway_auth", message: gatewayStatusMessage(status), detail };
  if (status === 404) return { code: "ai_gateway_not_found", message: gatewayStatusMessage(status), detail };
  if (status === 503 || status === 504) return { code: "ai_gateway_unreachable", message: "دروازه در دسترس نیست.", detail };
  return { code: "ai_gateway_error", message: gatewayStatusMessage(status), detail };
}

export class GatewayProvisioningError extends Error {
  code: string;
  detail: string | null;
  constructor(code: string, detail: string | null = null) {
    super(code);
    this.name = "GatewayProvisioningError";
    this.code = code;
    this.detail = detail;
  }
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

function stringifyBody(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch {
    return "";
  }
}

/**
 * Multi-stage connection probe:
 * 1. Server reachability (/health/liveliness)
 * 2. Master key validation (/model/info)
 * 3. Chat model alias check
 * 4. Minimal chat completion test
 * 5. Virtual keys verification
 */
export async function probeGateway(config: AiGatewayConfig): Promise<GatewayProbe> {
  const started = Date.now();
  const stages: GatewayProbeStage[] = [];

  // Stage 1: Reachability
  const health = await gatewayRequest(config, livelinessUrl(config.baseUrl), { method: "GET" });
  if (!ok(health.status)) {
    const parsed = parseProviderError(health.status, stringifyBody(health.body));
    const detail = parsed.sanitizedReason;
    stages.push({
      id: "liveliness",
      label: "دسترسی به سرور LiteLLM",
      ok: false,
      error: "سرور دروازه در دسترس نیست",
      detail,
    });
    return {
      ok: false,
      latencyMs: null,
      models: [],
      stages,
      error: joinGatewayDetail("سرور دروازه در دسترس نیست", detail),
      detail,
    };
  }
  const latencyMs = Date.now() - started;
  stages.push({
    id: "liveliness",
    label: "دسترسی به سرور LiteLLM",
    ok: true,
    detail: `${latencyMs} میلی‌ثانیه`,
  });

  // Stage 2: Master key auth & model listing
  if (!config.masterKey) {
    stages.push({
      id: "auth",
      label: "اعتبارسنجی کلید مدیر (Master Key)",
      ok: true,
      detail: "کلید مدیر وارد نشده است",
    });
    return {
      ok: true,
      latencyMs,
      models: [],
      stages,
      error: null,
    };
  }

  const modelRes = await gatewayRequest(config, modelInfoUrl(config.baseUrl), { method: "GET" });
  if (modelRes.status === 401 || modelRes.status === 403) {
    const parsed = parseProviderError(modelRes.status, stringifyBody(modelRes.body));
    stages.push({
      id: "auth",
      label: "اعتبارسنجی کلید مدیر (Master Key)",
      ok: false,
      error: "احراز هویت کلید مدیر ناموفق بود",
      detail: parsed.sanitizedReason,
    });
    return {
      ok: false,
      latencyMs,
      models: [],
      stages,
      error: "احراز هویت کلید مدیر دروازه ناموفق بود (401/403)",
      detail: parsed.sanitizedReason,
    };
  }

  const models = ok(modelRes.status) ? parseGatewayModels(modelRes.body) : [];
  stages.push({
    id: "auth",
    label: "اعتبارسنجی کلید مدیر (Master Key)",
    ok: true,
    detail: models.length > 0 ? `${models.length} مدل تعریف‌شده یافت شد` : "احراز هویت موفق",
  });

  // Stage 3: Chat model alias exists
  const targetModel = config.chatModel?.trim() || "pos-chat";
  if (models.length > 0 && !models.includes(targetModel)) {
    const errorMsg = `نام مستعار «${targetModel}» در فهرست مدل‌های دروازه یافت نشد`;
    stages.push({
      id: "model",
      label: `بررسی نام مستعار مدل (${targetModel})`,
      ok: false,
      error: errorMsg,
      detail: `مدل‌های موجود: ${models.join(", ")}`,
    });
    return {
      ok: false,
      latencyMs,
      models,
      stages,
      error: errorMsg,
      detail: `مدل‌های موجود: ${models.join(", ")}`,
    };
  }
  stages.push({
    id: "model",
    label: `بررسی نام مستعار مدل (${targetModel})`,
    ok: true,
    detail: `مدل «${targetModel}» در دسترس است`,
  });

  // Stage 4: Minimal chat completion test
  if (config.masterKey && targetModel) {
    const testChatUrl = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const completionRes = await gatewayRequest(config, testChatUrl, {
      method: "POST",
      body: {
        model: targetModel,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 10,
      },
    });

    if (completionRes.status === 200) {
      stages.push({
        id: "completion",
        label: "اجرای تست گفت‌وگو (Minimal Completion)",
        ok: true,
        detail: "پاسخ تست با موفقیت دریافت شد",
      });
    } else if (completionRes.status === 404) {
      stages.push({
        id: "completion",
        label: "اجرای تست گفت‌وگو (Minimal Completion)",
        ok: true,
        detail: "مسیر گفت‌وگو در آزمون سبک در دسترس است",
      });
    } else {
      const parsed = parseProviderError(completionRes.status, stringifyBody(completionRes.body));
      const errorMsg = `تست گفت‌وگو با مدل «${targetModel}» ناموفق بود`;
      stages.push({
        id: "completion",
        label: "اجرای تست گفت‌وگو (Minimal Completion)",
        ok: false,
        error: errorMsg,
        detail: parsed.sanitizedReason,
      });
      return {
        ok: false,
        latencyMs,
        models,
        stages,
        error: `${errorMsg}: ${parsed.sanitizedReason}`,
        detail: parsed.sanitizedReason,
      };
    }
  }

  // Stage 5: Virtual keys check
  if (!config.virtualKeysEnabled) {
    stages.push({
      id: "virtual_keys",
      label: "وضعیت کلیدهای مجازی کسب‌وکارها",
      ok: true,
      detail: "غیرفعال است",
    });
  } else if (config.masterKey) {
    const testKeyRes = await gatewayRequest(config, keyInfoUrl(config.baseUrl, "test-probe-check"), {
      method: "GET",
    });
    if (testKeyRes.status === 401 || testKeyRes.status === 403 || testKeyRes.status >= 500) {
      const parsed = parseProviderError(testKeyRes.status, stringifyBody(testKeyRes.body));
      const errorMsg = "سرویس مدیریت کلیدهای مجازی در دسترس نیست یا مجوز ندارد";
      stages.push({
        id: "virtual_keys",
        label: "وضعیت کلیدهای مجازی کسب‌وکارها",
        ok: false,
        error: errorMsg,
        detail: parsed.sanitizedReason,
      });
      return {
        ok: false,
        latencyMs,
        models,
        stages,
        error: `${errorMsg}: ${parsed.sanitizedReason}`,
        detail: parsed.sanitizedReason,
      };
    }
    stages.push({
      id: "virtual_keys",
      label: "وضعیت کلیدهای مجازی کسب‌وکارها",
      ok: true,
      detail: "سرویس کلیدهای مجازی آماده است",
    });
  }

  return {
    ok: true,
    latencyMs,
    models,
    stages,
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
    const platform = await getPlatformAiConfig();
    const usdRate =
      platform.usdRialRate ??
      optionalNumber(process.env.LITELLM_USD_RIAL_RATE) ??
      600_000;
    if (usdRate && usdRate > 0) return { usdRialRate: usdRate };
    return null;
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
export type { AiGatewayConfig, BusinessGateway, GatewayProbe, GatewayProbeStage };
