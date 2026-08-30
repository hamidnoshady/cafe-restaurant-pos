/**
 * Phase 37 — the business's own view of the gateway.
 *
 * A business owner sees exactly two things here: which model their assistant
 * is actually using, and — when the platform has enabled it — the ability to
 * choose a different one from the list the platform published. Nothing else
 * crosses the boundary: no gateway address, no admin key, no virtual key, no
 * other business. Virtual keys and USD budgets are provisioned by the platform
 * console and are invisible here on purpose; the number a business pays
 * attention to is its Rial balance, which /api/ai/billing already serves.
 *
 * The choice is deliberately narrow. The platform buys the tokens and bills
 * the business afterwards, so an open-ended model picker would be an open
 * invoice — the value is validated against `published_models` and rejected if
 * the platform has since withdrawn that model.
 */
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { getPlatformAiConfig } from "@/lib/ai-config";
import { getAiGatewayConfig, getBusinessGateway, saveBusinessGateway } from "@/lib/ai-gateway-service";
import { isGatewayActive, resolveChatModel, validateBusinessGatewayInput } from "@/lib/ai-gateway";
import { isFeatureEnabled } from "@/lib/features";

export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const platform = await getPlatformAiConfig();
  const gateway = await getAiGatewayConfig();
  const business = await getBusinessGateway(session.businessId);

  const active = isGatewayActive(gateway) && platform.provider === "litellm";
  const allowed = active && gateway.allowBusinessModels;

  return NextResponse.json({
    // False when the platform has no gateway, or has one but is not routing
    // through it: in both cases there is nothing here for the owner to see,
    // and the panel hides itself rather than showing an empty control.
    available: active,
    allowBusinessModels: allowed,
    /** The model in force right now — the platform's, or this business's own. */
    effectiveModel: active
      ? resolveChatModel({ platformModel: platform.model, gateway, business })
      : platform.model,
    platformModel: platform.model,
    publishedModels: allowed ? gateway.publishedModels : [],
    modelOverride: business?.modelOverride ?? null,
    /** Whether this business's calls carry a key of its own at the gateway. */
    hasVirtualKey: Boolean(business?.virtualKey),
    syncError: business?.syncError ?? null,
  });
});

/** Set (or clear) this business's model choice. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  if (!(await isFeatureEnabled(session.businessId, "ai_assistant"))) {
    return NextResponse.json({ error: "feature_locked" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const gateway = await getAiGatewayConfig();
  if (!isGatewayActive(gateway) || !gateway.allowBusinessModels) {
    return NextResponse.json({ error: "ai_gateway_model_choice_disabled" }, { status: 409 });
  }

  const raw = body.modelOverride;
  const input = {
    modelOverride: raw === null || raw === "" ? null : typeof raw === "string" ? raw : undefined,
  };
  const errors = validateBusinessGatewayInput(input, {
    allowBusinessModels: gateway.allowBusinessModels,
    allowedModels: gateway.publishedModels,
  });
  if (errors.length > 0) return NextResponse.json({ error: errors[0], errors }, { status: 400 });

  const row = await saveBusinessGateway(session.businessId, input, gateway);
  return NextResponse.json({ modelOverride: row.modelOverride });
});
