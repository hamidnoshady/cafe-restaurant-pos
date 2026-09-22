/**
 * Phase 37 & Phase 39 — the console's gateway operations.
 *
 * Supports global LiteLLM settings, business virtual keys, and branch-level overrides.
 *
 * Migration 0168 (single AI billing architecture): the console no longer
 * mirrors proxy-side settings (routing, default key budgets, TPM/RPM) — LiteLLM
 * owns those, and the request path never read them. What this route ADDS is
 * the platform-side picture the proxy cannot know: each business's request
 * count, token usage, charged cost and remaining credit (wallet + the plan's
 * monthly AI allowance), and the platform's own AI revenue totals.
 */
import { NextRequest, NextResponse } from "next/server";
import { getAiRuntimeReadiness, getPlatformAiConfig } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import {
  GatewayProvisioningError,
  getAiGatewayConfig,
  getBusinessGateway,
  listBusinessGateways,
  mergeGatewayConfig,
  probeGateway,
  provisionVirtualKey,
  refreshKeySpend,
  revokeVirtualKey,
  saveAiGatewayConfig,
  saveBusinessGateway,
  toPublicAiGatewayConfig,
  toPublicBusinessGateway,
} from "@/lib/ai-gateway-service";
import {
  isGatewayActive,
  validateGatewayInput,
  type AiGatewayInput,
  type BusinessGatewayInput,
} from "@/lib/ai-gateway";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { query, withoutTenantScope } from "@/lib/db";

/** One business's AI billing picture, for the key-management dashboard. */
interface BusinessUsageRow extends Record<string, unknown> {
  business_id: string;
  total_requests: string | number;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  charged_rial: string | number;
}

interface WalletRow extends Record<string, unknown> {
  business_id: string;
  balance_rial: string | number;
}

interface AllowanceRow extends Record<string, unknown> {
  business_id: string;
  monthly_credit: string | number | null;
  used: string | number | null;
}

/**
 * The per-business usage/credit read, platform-scoped. Three aggregate
 * queries (settlements, wallets, plan allowance) joined in memory — the
 * businesses list is small and each source is indexed by business_id.
 */
async function readBusinessUsage(): Promise<{
  businessUsage: {
    businessId: string;
    totalRequests: number;
    inputTokens: number;
    outputTokens: number;
    chargedRial: number;
    balanceRial: number;
    monthlyAiCreditRial: number;
    allowanceUsedRial: number;
    allowanceRemainingRial: number;
  }[];
  platformRevenue: { totalChargedRial: number; monthChargedRial: number; totalRequests: number };
}> {
  return withoutTenantScope("platform", async () => {
    const periodMonth = new Date().toISOString().slice(0, 7);
    const [usageRes, walletRes, allowanceRes, revenueRes] = await Promise.all([
      query<BusinessUsageRow>(
        `SELECT business_id,
                count(*) AS total_requests,
                coalesce(sum(input_tokens), 0) AS input_tokens,
                coalesce(sum(output_tokens), 0) AS output_tokens,
                coalesce(sum(charged_rial), 0) AS charged_rial
           FROM ai_wallet_settlements
          GROUP BY business_id`,
      ),
      query<WalletRow>(`SELECT business_id, balance_rial FROM business_wallets`),
      query<AllowanceRow>(
        `SELECT b.id AS business_id,
                p.monthly_ai_credit_rial AS monthly_credit,
                a.used_rial AS used
           FROM businesses b
           LEFT JOIN billing_plans p ON p.key = b.plan
           LEFT JOIN ai_plan_allowance_usage a
                  ON a.business_id = b.id AND a.period_month = $1`,
        [periodMonth],
      ),
      query<{ total_charged: string | number; month_charged: string | number; total_requests: string | number }>(
        `SELECT coalesce(sum(charged_rial), 0) AS total_charged,
                coalesce(sum(charged_rial) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS month_charged,
                count(*) AS total_requests
           FROM ai_wallet_settlements`,
      ),
    ]);

    const num = (v: string | number | null | undefined) => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    const usageByBusiness = new Map(usageRes.rows.map((row) => [row.business_id, row]));
    const walletByBusiness = new Map(walletRes.rows.map((row) => [row.business_id, row]));
    const allowanceByBusiness = new Map(allowanceRes.rows.map((row) => [row.business_id, row]));

    // Every non-archived business gets a row, so the dashboard shows the
    // businesses with no usage at all rather than silently omitting them.
    const { rows: allBusinesses } = await query<{ id: string }>(
      `SELECT id FROM businesses WHERE status <> 'archived'`,
    );

    const businessUsage = allBusinesses.map((b) => {
      const usage = usageByBusiness.get(b.id);
      const allowance = allowanceByBusiness.get(b.id);
      const monthlyCredit = num(allowance?.monthly_credit);
      const used = num(allowance?.used);
      return {
        businessId: b.id,
        totalRequests: num(usage?.total_requests),
        inputTokens: num(usage?.input_tokens),
        outputTokens: num(usage?.output_tokens),
        chargedRial: num(usage?.charged_rial),
        balanceRial: num(walletByBusiness.get(b.id)?.balance_rial),
        monthlyAiCreditRial: monthlyCredit,
        allowanceUsedRial: used,
        allowanceRemainingRial: Math.max(0, monthlyCredit - used),
      };
    });

    const revenue = revenueRes.rows[0];
    return {
      businessUsage,
      platformRevenue: {
        totalChargedRial: num(revenue?.total_charged),
        monthChargedRial: num(revenue?.month_charged),
        totalRequests: num(revenue?.total_requests),
      },
    };
  });
}

/** Gateway state, plus a live probe when the operator asked for one. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.read");
  if (error) return error;

  const platform = await getPlatformAiConfig();
  const platformReadiness = getAiRuntimeReadiness(platform);
  if (platformReadiness.reason === "configuration_load_failed") {
    return NextResponse.json(
      { error: "ai_configuration_load_failed", runtimeReadiness: platformReadiness },
      { status: 503 },
    );
  }

  const [gateway, gateways, locationsRes, businessesRes, usage] = await Promise.all([
    getAiGatewayConfig(),
    listBusinessGateways(),
    withoutTenantScope("platform", () =>
      query<{ id: string; business_id: string; name: string }>(
        `SELECT id, business_id, name FROM locations ORDER BY name`,
      ),
    ),
    withoutTenantScope("platform", () =>
      query<{ id: string; name: string; ai_entitled: boolean }>(
        `SELECT b.id, b.name,
                COALESCE(bf.enabled, ff.default_enabled, false) AS ai_entitled
           FROM businesses b
           LEFT JOIN feature_flags ff ON ff.key = 'ai_assistant'
           LEFT JOIN business_features bf ON bf.business_id = b.id AND bf.flag_key = ff.key
          WHERE b.status <> 'archived' ORDER BY b.name`,
      ),
    ),
    readBusinessUsage(),
  ]);

  const runtimeReadiness = getAiRuntimeReadiness(platform);
  const tenantReadiness = await Promise.all(
    businessesRes.rows.map(async (business) => {
      const config = await resolveAiConfigFor(business.id, null);
      return { businessId: business.id, entitled: business.ai_entitled, ...getAiRuntimeReadiness(config) };
    }),
  );

  const canManage = session.role === "owner";
  const wantsProbe = request.nextUrl.searchParams.get("probe") === "1";
  const status = canManage && wantsProbe ? await probeGateway(gateway) : null;

  return NextResponse.json({
    gateway: canManage ? toPublicAiGatewayConfig(gateway) : null,
    provider: platform.provider,
    platformModel: platform.model,
    platformBaseUrl: gateway.baseUrl,
    providerIsGateway: true,
    active: runtimeReadiness.ready,
    runtimeReadiness,
    tenantReadiness,
    status,
    gateways: gateways.map((row) => toPublicBusinessGateway(row, gateway, platform.model)),
    locations: locationsRes.rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      name: r.name,
    })),
    businesses: businessesRes.rows.map((r) => ({
      businessId: r.id,
      businessName: r.name,
      aiEntitled: r.ai_entitled,
    })),
    businessUsage: usage.businessUsage,
    platformRevenue: usage.platformRevenue,
  });
});

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Owner-only: the gateway connection, and an on-demand connection test. */
export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.action === "probe") {
    const draft = body.gateway;
    if (!draft || typeof draft !== "object") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const current = await getAiGatewayConfig();
    const merged = mergeGatewayConfig(draft as AiGatewayInput, current);
    return NextResponse.json({ status: await probeGateway(merged) });
  }

  if (body.action === "config") {
    const raw = body.gateway;
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const input = raw as AiGatewayInput;
    const current = await getAiGatewayConfig();
    const merged = mergeGatewayConfig(input, current);
    const errors = validateGatewayInput(merged);
    if (errors.length > 0) return NextResponse.json({ error: errors[0], errors }, { status: 400 });
    const saved = await saveAiGatewayConfig(input);
    await platformAudit({
      adminId: session.padmin,
      action: "ai.gateway.save",
      entity: "platform_ai_gateway",
      entityId: "true",
      payload: {
        enabled: saved.enabled,
        baseUrl: saved.baseUrl,
        virtualKeysEnabled: saved.virtualKeysEnabled,
        allowBusinessModels: saved.allowBusinessModels,
        fallbackCount: saved.fallbackModels.length,
      },
    });
    return NextResponse.json({ gateway: toPublicAiGatewayConfig(saved) });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});

/** Engineer/owner: per-business and per-branch key lifecycle and spend controls. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.credits.manage");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessId = typeof body.businessId === "string" ? body.businessId : "";
  const locationId = typeof body.locationId === "string" && body.locationId ? body.locationId : null;
  if (!businessId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const platform = await getPlatformAiConfig();
  const gateway = await getAiGatewayConfig();

  if (body.action === "sync_key") {
    // Pre-flight: each of these states would end in a guaranteed-failing or
    // guaranteed-useless key, so the operator hears *that* instead of an
    // opaque 502 from a call that was never going to work. They are 400s —
    // operator-fixable configuration, not an upstream failure.
    if (!isGatewayActive(gateway)) {
      return NextResponse.json({ error: "ai_gateway_disabled" }, { status: 400 });
    }
    if (!gateway.masterKey) {
      return NextResponse.json({ error: "ai_gateway_missing_master_key" }, { status: 400 });
    }
    // A key minted while the toggle is off would never authenticate anything:
    // resolveGatewayAuthKey only consults business keys once virtual keys are
    // enabled, so the console must not let one be minted into that limbo.
    if (!gateway.virtualKeysEnabled) {
      return NextResponse.json({ error: "ai_gateway_virtual_keys_disabled" }, { status: 400 });
    }

    const existing = await getBusinessGateway(businessId, locationId);
    try {
      // Migration 0168: the minted key carries identity only — no models
      // allowlist, no budgets, no rate limits. LiteLLM owns those.
      const row = await provisionVirtualKey(gateway, {
        businessId,
        locationId,
      });
      await platformAudit({
        adminId: session.padmin,
        businessId,
        action: existing?.virtualKey ? "ai.gateway.key.update" : "ai.gateway.key.create",
        entity: "ai_business_gateway",
        entityId: locationId ? `${businessId}:${locationId}` : businessId,
        payload: { keyAlias: row.keyAlias, locationId, syncError: row.syncError },
      });
      return NextResponse.json({ gateway: toPublicBusinessGateway(row, gateway, platform.model) });
    } catch (err) {
      if (err instanceof GatewayProvisioningError) {
        // The gateway answered but refused — the proxy's own explanation is
        // the most actionable thing the operator can be shown.
        return NextResponse.json({ error: err.code, detail: err.detail }, { status: 502 });
      }
      if (err instanceof Error && err.message.startsWith("ai_gateway")) {
        return NextResponse.json({ error: err.message }, { status: 502 });
      }
      throw err;
    }
  }

  if (body.action === "revoke_key") {
    await revokeVirtualKey(gateway, businessId, locationId);
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "ai.gateway.key.revoke",
      entity: "ai_business_gateway",
      entityId: locationId ? `${businessId}:${locationId}` : businessId,
      payload: { locationId },
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "refresh_spend") {
    const row = await refreshKeySpend(gateway, businessId, locationId);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ gateway: toPublicBusinessGateway(row, gateway, platform.model) });
  }

  if (body.action === "business") {
    try {
      const input = businessInput(body);
      const row = await saveBusinessGateway(businessId, input, gateway, locationId);
      await platformAudit({
        adminId: session.padmin,
        businessId,
        action: "ai.gateway.business.save",
        entity: "ai_business_gateway",
        entityId: locationId ? `${businessId}:${locationId}` : businessId,
        payload: { ...input, locationId },
      });
      return NextResponse.json({ gateway: toPublicBusinessGateway(row, gateway, platform.model) });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("ai_gateway")) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});

function businessInput(body: Record<string, unknown>): BusinessGatewayInput {
  return {
    modelOverride: body.modelOverride === null ? null : optionalText(body.modelOverride),
  };
}
