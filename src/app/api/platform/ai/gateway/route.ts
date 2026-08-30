/**
 * Phase 37 & Phase 39 — the console's gateway operations.
 *
 * Supports global LiteLLM settings, business virtual keys, and branch-level overrides.
 */
import { NextRequest, NextResponse } from "next/server";
import { getPlatformAiConfig } from "@/lib/ai-config";
import {
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
  toStringList,
  validateGatewayInput,
  type AiGatewayConfig,
  type AiGatewayInput,
  type BusinessGatewayInput,
} from "@/lib/ai-gateway";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { query, withoutTenantScope } from "@/lib/db";

/** Gateway state, plus a live probe when the operator asked for one. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.read");
  if (error) return error;

  const [platform, gateway, gateways, locationsRes] = await Promise.all([
    getPlatformAiConfig(),
    getAiGatewayConfig(),
    listBusinessGateways(),
    withoutTenantScope("platform", () =>
      query<{ id: string; business_id: string; name: string }>(
        `SELECT id, business_id, name FROM locations ORDER BY name`,
      ),
    ),
  ]);

  const canManage = session.role === "owner";
  const wantsProbe = request.nextUrl.searchParams.get("probe") === "1";
  const status = canManage && wantsProbe ? await probeGateway(gateway) : null;

  return NextResponse.json({
    gateway: canManage ? toPublicAiGatewayConfig(gateway) : null,
    provider: platform.provider,
    platformModel: platform.model,
    platformBaseUrl: gateway.baseUrl,
    providerIsGateway: true,
    active: isGatewayActive(gateway),
    status,
    gateways: gateways.map((row) => toPublicBusinessGateway(row, gateway, platform.model)),
    locations: locationsRes.rows.map((r) => ({
      id: r.id,
      businessId: r.business_id,
      name: r.name,
    })),
  });
});

function safeNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeInteger(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

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
    const errors = validateGatewayInput(input);
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
    const existing = await getBusinessGateway(businessId, locationId);
    try {
      const row = await provisionVirtualKey(gateway, platform.model, {
        businessId,
        locationId,
        models: toStringList(body.models),
        maxBudgetUsd: pickNumber(body.maxBudgetUsd, gateway.defaultMaxBudgetUsd),
        budgetDuration: optionalText(body.budgetDuration) ?? gateway.defaultBudgetDuration,
        tpmLimit: safeInteger(body.tpmLimit) ?? gateway.defaultTpmLimit,
        rpmLimit: safeInteger(body.rpmLimit) ?? gateway.defaultRpmLimit,
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

function pickNumber(value: unknown, fallback: number | null): number | null {
  const n = safeNumber(value);
  if (n === null) return fallback;
  return n > 0 ? n : null;
}

function businessInput(body: Record<string, unknown>): BusinessGatewayInput {
  return {
    modelOverride: body.modelOverride === null ? null : optionalText(body.modelOverride),
    maxBudgetUsd: body.maxBudgetUsd === null ? null : safeNumber(body.maxBudgetUsd),
    budgetDuration: body.budgetDuration === null ? null : optionalText(body.budgetDuration),
    tpmLimit: body.tpmLimit === null ? null : safeInteger(body.tpmLimit),
    rpmLimit: body.rpmLimit === null ? null : safeInteger(body.rpmLimit),
  };
}
