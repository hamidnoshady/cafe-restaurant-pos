/**
 * Phase 37, Phase 39 & Phase 40 — technical LiteLLM administration API.
 *
 * Exclusively handles LiteLLM connection parameters, model aliases, and
 * business/branch virtual-key management. All billing, money, revenue,
 * allowances and tenant monetization belong strictly to Plan/Billing.
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

/** Technical LiteLLM gateway status, models, readiness and virtual keys. */
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

  const [gateway, gateways, locationsRes, businessesRes] = await Promise.all([
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
  });
});

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Owner/Admin: LiteLLM connection setup and on-demand comprehensive probe. */
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
    const probeResult = await probeGateway(merged);
    return NextResponse.json({ status: probeResult });
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
        chatModel: saved.chatModel,
        embeddingModel: saved.embeddingModel,
        virtualKeysEnabled: saved.virtualKeysEnabled,
        allowBusinessModels: saved.allowBusinessModels,
      },
    });
    return NextResponse.json({ gateway: toPublicAiGatewayConfig(saved) });
  }

  return NextResponse.json({ error: "bad_request" }, { status: 400 });
});

/** Manage business and branch virtual keys and model overrides. */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
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
    if (!isGatewayActive(gateway)) {
      return NextResponse.json({ error: "ai_gateway_disabled" }, { status: 400 });
    }
    if (!gateway.masterKey) {
      return NextResponse.json({ error: "ai_gateway_missing_master_key" }, { status: 400 });
    }
    if (!gateway.virtualKeysEnabled) {
      return NextResponse.json({ error: "ai_gateway_virtual_keys_disabled" }, { status: 400 });
    }

    const existing = await getBusinessGateway(businessId, locationId);
    try {
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
