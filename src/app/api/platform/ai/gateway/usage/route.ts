/**
 * Phase 38b — the console's usage analytics, sourced from the gateway.
 *
 * The read is free: it serves the stored daily rollup (`ai_gateway_usage`,
 * filled by the sync below) with no gateway round-trip, so the console can
 * render on demand even while the proxy is down. The write is the operator's
 * "sync" button: one pull of the proxy's spend logs for a rolling window,
 * aggregated and upserted — re-running it converges rather than double
 * counts, which is what makes a failed sync safe to simply retry.
 *
 * Capability split mirrors the rest of the gateway console: `ai.read` may see
 * what was spent, `ai.config.manage` (owner) may talk to the gateway, because
 * the sync uses the master key and a partial failure is worth knowing about
 * at the owner level.
 */
import { NextRequest, NextResponse } from "next/server";
import { getPlatformAiConfig } from "@/lib/ai-config";
import {
  getAiGatewayConfig,
  listGatewayUsage,
  resolveGatewayCosting,
  syncGatewayUsage,
} from "@/lib/ai-gateway-service";
import { rialFromGatewayUsd } from "@/lib/ai-gateway";
import { platformAudit, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

function windowFor(days: number): { fromDay: string; toDay: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { fromDay: from, toDay: to };
}

function dayOffset(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("ai.read");
  if (error) return error;

  const requested = Number(request.nextUrl.searchParams.get("days"));
  const locationId = request.nextUrl.searchParams.get("locationId")?.trim() || null;
  const days = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_DAYS) : DEFAULT_DAYS;
  const [usage, costing] = await Promise.all([
    listGatewayUsage({ ...windowFor(days), locationId }),
    resolveGatewayCosting(),
  ]);
  const rate = costing?.usdRialRate ?? null;

  // Totals over the window, with the same USD→Rial conversion the settlement
  // uses — a diagnostic beside the ledger, never a ledger figure itself.
  const totals = usage.reduce(
    (acc, row) => {
      acc.spendUsd += row.spendUsd;
      acc.promptTokens += row.promptTokens;
      acc.completionTokens += row.completionTokens;
      acc.apiRequests += row.apiRequests;
      return acc;
    },
    { spendUsd: 0, promptTokens: 0, completionTokens: 0, apiRequests: 0 },
  );

  return NextResponse.json({
    days,
    usage: usage.map((row) => ({
      ...row,
      spendRial: rate ? rialFromGatewayUsd(row.spendUsd, rate) : null,
    })),
    totals: {
      ...totals,
      spendRial: rate ? rialFromGatewayUsd(totals.spendUsd, rate) : null,
    },
    gatewayCosting: {
      enabled: Boolean(costing),
      usdRialRate: rate,
      oldestDayCovered: dayOffset(DEFAULT_DAYS),
    },
  });
});

export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("ai.config.manage");
  if (error) return error;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const requested = Number(body.days);
  const days = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_DAYS) : DEFAULT_DAYS;

  const [platform, gateway] = await Promise.all([getPlatformAiConfig(), getAiGatewayConfig()]);
  const resolved = {
    ...gateway,
    baseUrl:
      platform.provider === "litellm" && platform.baseUrl
        ? platform.baseUrl
        : gateway.baseUrl,
  };
  const result = await syncGatewayUsage(resolved, { days });
  await platformAudit({
    adminId: session.padmin,
    action: "ai.gateway.usage.sync",
    entity: "ai_gateway_usage",
    entityId: "true",
    payload: { days, ok: result.ok, entries: result.entries, rows: result.rows, error: result.error },
  });
  return NextResponse.json({ sync: result }, { status: result.ok ? 200 : 502 });
});
