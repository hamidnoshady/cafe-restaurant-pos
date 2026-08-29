/**
 * Phase 37 — the console's gateway operations.
 *
 * Deliberately its own route rather than another `action` branch on
 * /api/platform/ai: that handler already owns the provider connection, the
 * credit catalogue and top-up reviews, and the gateway adds four more verbs
 * plus a network call. Mixing them would put an operator's "test connection"
 * button in the same request path that grants money.
 *
 * The capability split follows the one /api/platform/ai already uses:
 * `ai.config.manage` (owner) for the gateway connection itself, because it
 * holds the gateway's admin credential, and `ai.credits.manage` (owner and
 * engineer) for per-business keys, budgets and rate limits — those are spend
 * controls, not connection secrets.
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
  resolveGatewayBaseUrl,
  toStringList,
  validateGatewayInput,
  type AiGatewayConfig,
  type AiGatewayInput,
  type BusinessGatewayInput,
} from "@/lib/ai-gateway";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";

/**
 * The gateway config as management calls will use it: the address resolved to
 * the one authoritative endpoint, so keys are never minted on a different host
 * than the one chat goes to.
 */
function effectiveGateway(platform: { provider: string; baseUrl: string }, gateway: AiGatewayConfig) {
  return {
    ...gateway,
    baseUrl: resolveGatewayBaseUrl({
      platformBaseUrl: platform.baseUrl,
      providerIsGateway: platform.provider === "litellm",
      gatewayBaseUrl: gateway.baseUrl,
    }),
  };
}

/** Gateway state, plus a live probe when the operator asked for one. */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.read");
  if (error) return error;

  const [platform, gateway, gateways] = await Promise.all([
    getPlatformAiConfig(),
    getAiGatewayConfig(),
    listBusinessGateways(),
  ]);

  const resolved = effectiveGateway(platform, gateway);
  const canManage = session.role === "owner";
  const wantsProbe = request.nextUrl.searchParams.get("probe") === "1";
  const status = canManage && wantsProbe ? await probeGateway(resolved) : null;

  return NextResponse.json({
    // A support/engineer admin may see that a gateway is in play, but not its
    // address, its aliases or even whether an admin key is stored — the same
    // carve-out /api/platform/ai already applies to the provider connection.
    gateway: canManage ? toPublicAiGatewayConfig(resolved) : null,
    provider: platform.provider,
    platformModel: platform.model,
    // The console needs to show where the address actually comes from.
    platformBaseUrl: platform.baseUrl,
    providerIsGateway: platform.provider === "litellm",
    active: isGatewayActive(gateway) && platform.provider === "litellm",
    status,
    gateways: gateways.map((row) => toPublicBusinessGateway(row, gateway, platform.model)),
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

  // A probe writes nothing: it is the operator pressing "test connection"
  // before saving, and it must work against the draft in the form as well as
  // against what is stored.
  if (body.action === "probe") {
    const draft = body.gateway;
    if (!draft || typeof draft !== "object") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const [current, platform] = await Promise.all([getAiGatewayConfig(), getPlatformAiConfig()]);
    const merged = effectiveGateway(platform, mergeGatewayConfig(draft as AiGatewayInput, current));
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

/** Engineer/owner: per-business key lifecycle and spend controls. */
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
  if (!businessId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const platform = await getPlatformAiConfig();
  const gateway = effectiveGateway(platform, await getAiGatewayConfig());

  if (body.action === "sync_key") {
    const existing = await getBusinessGateway(businessId);
    try {
      const row = await provisionVirtualKey(gateway, platform.model, {
        businessId,
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
        entityId: businessId,
        payload: { keyAlias: row.keyAlias, syncError: row.syncError },
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
    await revokeVirtualKey(gateway, businessId);
    await platformAudit({
      adminId: session.padmin,
      businessId,
      action: "ai.gateway.key.revoke",
      entity: "ai_business_gateway",
      entityId: businessId,
    });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "refresh_spend") {
    const row = await refreshKeySpend(gateway, businessId);
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ gateway: toPublicBusinessGateway(row, gateway, platform.model) });
  }

  if (body.action === "business") {
    try {
      const input = businessInput(body);
      const row = await saveBusinessGateway(businessId, input, gateway);
      await platformAudit({
        adminId: session.padmin,
        businessId,
        action: "ai.gateway.business.save",
        entity: "ai_business_gateway",
        entityId: businessId,
        payload: { ...input },
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
