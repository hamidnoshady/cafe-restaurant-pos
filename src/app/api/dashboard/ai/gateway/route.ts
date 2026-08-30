/**
 * Phase 37 & Phase 39 — the business's own view of the gateway.
 *
 * A business owner sees: which model their assistant is using (globally, or
 * overridden per branch), and when permitted, can choose an override per business
 * or branch.
 */
import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { getPlatformAiConfig } from "@/lib/ai-config";
import {
  getAiGatewayConfig,
  getBusinessGateway,
  listBranchGateways,
  listBusinessGatewayUsage,
  resolveGatewayCosting,
  saveBusinessGateway,
} from "@/lib/ai-gateway-service";
import { isGatewayActive, rialFromGatewayUsd, resolveChatModel, validateBusinessGatewayInput } from "@/lib/ai-gateway";
import { isFeatureEnabled } from "@/lib/features";
import { query } from "@/lib/db";

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  const url = new URL(request.url);
  const locationIdParam = url.searchParams.get("locationId")?.trim() || null;

  const platform = await getPlatformAiConfig();
  const gateway = await getAiGatewayConfig();
  const business = await getBusinessGateway(session.businessId, null);
  const branch = locationIdParam ? await getBusinessGateway(session.businessId, locationIdParam) : null;
  const branchGateways = await listBranchGateways(session.businessId);

  const { rows: locations } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations WHERE business_id = $1 ORDER BY name`,
    [session.businessId],
  );

  const active = isGatewayActive(gateway);
  const allowed = active && gateway.allowBusinessModels;

  let usage: { day: string; model: string; spendUsd: number; spendRial: number | null; promptTokens: number; completionTokens: number; apiRequests: number }[] = [];
  if (active) {
    try {
      const costing = await resolveGatewayCosting();
      const toDay = new Date().toISOString().slice(0, 10);
      const fromDay = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const rows = await listBusinessGatewayUsage({ fromDay, toDay, locationId: locationIdParam });
      usage = rows.map((row) => ({
        day: row.day,
        model: row.model,
        spendUsd: row.spendUsd,
        spendRial: costing ? rialFromGatewayUsd(row.spendUsd, costing.usdRialRate) : null,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        apiRequests: row.apiRequests,
      }));
    } catch (err) {
      console.error("ai gateway usage unavailable for business", err);
    }
  }

  const effectiveModel = active
    ? resolveChatModel({
        platformModel: platform.model,
        gateway,
        business,
        branch,
      })
    : platform.model;

  return NextResponse.json({
    available: active,
    allowBusinessModels: allowed,
    effectiveModel,
    platformModel: platform.model,
    publishedModels: allowed ? gateway.publishedModels : [],
    modelOverride: branch ? branch.modelOverride : (business?.modelOverride ?? null),
    businessModelOverride: business?.modelOverride ?? null,
    branchModelOverride: branch?.modelOverride ?? null,
    hasVirtualKey: Boolean(branch ? branch.virtualKey : business?.virtualKey),
    syncError: branch ? branch.syncError : (business?.syncError ?? null),
    usage,
    locations,
    selectedLocationId: locationIdParam,
    branchOverrides: branchGateways.map((bg) => ({
      locationId: bg.locationId,
      modelOverride: bg.modelOverride,
      hasVirtualKey: Boolean(bg.virtualKey),
    })),
  });
});

/** Set (or clear) model choice for business or branch. */
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
  const locationId = typeof body.locationId === "string" && body.locationId.trim() ? body.locationId.trim() : null;

  if (locationId) {
    const { rows } = await query(`SELECT 1 FROM locations WHERE id = $1 AND business_id = $2`, [
      locationId,
      session.businessId,
    ]);
    if (rows.length === 0) {
      return NextResponse.json({ error: "location_not_found" }, { status: 404 });
    }
  }

  const input = {
    modelOverride: raw === null || raw === "" ? null : typeof raw === "string" ? raw : undefined,
  };
  const errors = validateBusinessGatewayInput(input, {
    allowBusinessModels: gateway.allowBusinessModels,
    allowedModels: gateway.publishedModels,
  });
  if (errors.length > 0) return NextResponse.json({ error: errors[0], errors }, { status: 400 });

  const row = await saveBusinessGateway(session.businessId, input, gateway, locationId);
  return NextResponse.json({ modelOverride: row.modelOverride, locationId: row.locationId });
});
