import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import {
  deductCredits,
  getWallet,
  grantCredits,
  listLedger,
  listPayments,
} from "@/lib/wallet-service";
import { listEntitlements } from "@/lib/billing-plans-service";
import { getPlatformAiConfig } from "@/lib/ai-config";
import {
  getAiGatewayConfig,
  listBusinessGateways,
  refreshKeySpend,
  toPublicBusinessGateway,
} from "@/lib/ai-gateway-service";
import { rialFromGatewayUsd } from "@/lib/ai-gateway";
import { query } from "@/lib/db";

/**
 * One business's billing state for the console: wallet balance, recent
 * ledger, entitlements, payments and per-feature usage.
 */
export const GET = withPlatformScope(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { error } = await requirePlatformAdmin();
    if (error) return error;
    const { id: businessId } = await ctx.params;

    const { rows: bizRows } = await query<{ name: string; plan: string }>(
      `SELECT name, plan FROM businesses WHERE id = $1`,
      [businessId],
    );
    if (!bizRows[0]) return NextResponse.json({ error: "business_not_found" }, { status: 404 });

    const [wallet, ledger, entitlements, payments, usage, gateway, platform, gatewayRows] =
      await Promise.all([
        getWallet(businessId),
        listLedger(businessId, 50),
        listEntitlements(businessId),
        listPayments({ businessId, limit: 50 }),
        query<{
          feature_key: string;
          used_count: string;
          charged_count: string;
          spent_rial: string;
        }>(
          `SELECT feature_key, used_count, charged_count, spent_rial
             FROM feature_usage WHERE business_id = $1
            ORDER BY spent_rial DESC, feature_key`,
          [businessId],
        ),
        getAiGatewayConfig(),
        getPlatformAiConfig(),
        listBusinessGateways(businessId),
      ]);

    // The LiteLLM side of this business: each virtual key's reported USD spend,
    // converted to Rial at the platform's stored rate so the console can show
    // the real cost the platform is paying LiteLLM for this business.
    const rate = platform.usdRialRate ?? gateway.usdRialRate ?? 0;
    const litellm = {
      costingEnabled: platform.gatewayCostingEnabled && rate > 0,
      usdRialRate: rate > 0 ? rate : null,
      totalSpendUsd: 0,
      totalSpendRial: 0,
      keys: gatewayRows.map((row) => {
        const pub = toPublicBusinessGateway(row, gateway, platform.model);
        return {
          locationId: pub.locationId,
          keyAlias: pub.keyAlias,
          effectiveModel: pub.effectiveModel,
          hasVirtualKey: pub.hasVirtualKey,
          spendUsd: row.spendUsd,
          spendRial: rate > 0 ? rialFromGatewayUsd(row.spendUsd, rate) : 0,
          syncedAt: pub.syncedAt,
          syncError: pub.syncError,
        };
      }),
    };
    litellm.totalSpendUsd = litellm.keys.reduce((sum, k) => sum + k.spendUsd, 0);
    litellm.totalSpendRial = litellm.keys.reduce((sum, k) => sum + k.spendRial, 0);

    return NextResponse.json({
      business: { id: businessId, name: bizRows[0].name, plan: bizRows[0].plan },
      wallet,
      ledger,
      entitlements,
      payments,
      litellm,
      usage: usage.rows.map((u) => ({
        featureKey: u.feature_key,
        usedCount: Number(u.used_count),
        chargedCount: Number(u.charged_count),
        spentRial: Number(u.spent_rial),
      })),
    });
  },
);

/**
 * Manual wallet adjustment by the super-admin: grant (positive) or deduct
 * (negative) credits with a note.
 */
export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("billing.manage");
    if (guard.error) return guard.error;
    const { id: businessId } = await ctx.params;

    let body: { amountRial?: number; note?: string; action?: string; locationId?: string | null };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    // Pull this business's live LiteLLM spend from the gateway on demand, so the
    // console shows what the platform is actually paying LiteLLM right now.
    if (body.action === "sync_litellm_spend") {
      const gateway = await getAiGatewayConfig();
      const platform = await getPlatformAiConfig();
      const locationId =
        typeof body.locationId === "string" && body.locationId ? body.locationId : null;
      if (locationId) {
        await refreshKeySpend(gateway, businessId, locationId);
      } else {
        const rows = await listBusinessGateways(businessId);
        await Promise.all(
          rows
            .filter((r) => Boolean(r.virtualKey))
            .map((r) => refreshKeySpend(gateway, businessId, r.locationId)),
        );
      }
      const rate = platform.usdRialRate ?? gateway.usdRialRate ?? 0;
      const rows = await listBusinessGateways(businessId);
      const keys = rows.map((row) => {
        const pub = toPublicBusinessGateway(row, gateway, platform.model);
        return {
          locationId: pub.locationId,
          keyAlias: pub.keyAlias,
          effectiveModel: pub.effectiveModel,
          hasVirtualKey: pub.hasVirtualKey,
          spendUsd: row.spendUsd,
          spendRial: rate > 0 ? rialFromGatewayUsd(row.spendUsd, rate) : 0,
          syncedAt: pub.syncedAt,
          syncError: pub.syncError,
        };
      });
      return NextResponse.json({
        litellm: {
          costingEnabled: platform.gatewayCostingEnabled && rate > 0,
          usdRialRate: rate > 0 ? rate : null,
          totalSpendUsd: keys.reduce((s, k) => s + k.spendUsd, 0),
          totalSpendRial: keys.reduce((s, k) => s + k.spendRial, 0),
          keys,
        },
      });
    }

    const amount = Math.floor(Number(body.amountRial ?? 0));
    if (amount === 0) return NextResponse.json({ error: "bad_amount" }, { status: 400 });

    try {
      const result =
        amount > 0
          ? await grantCredits({
              businessId,
              amountRial: amount,
              note: body.note?.trim() || undefined,
              platformAdminId: guard.session.padmin,
            })
          : await deductCredits({
              businessId,
              amountRial: Math.abs(amount),
              note: body.note?.trim() || undefined,
              platformAdminId: guard.session.padmin,
            });
      return NextResponse.json({ balanceRial: result.balanceRial });
    } catch (err) {
      if (err instanceof Error && err.message === "insufficient_credits") {
        return NextResponse.json({ error: "insufficient_credits" }, { status: 409 });
      }
      throw err;
    }
  },
);
