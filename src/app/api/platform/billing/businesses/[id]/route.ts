import { NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import {
  deductCredits,
  getWallet,
  grantCredits,
  listLedger,
  listPayments,
} from "@/lib/wallet-service";
import { listEntitlements } from "@/lib/billing-plans-service";
import {
  getBusinessSubscription,
  listInvoices,
  calculateSubscriptionTotal,
} from "@/lib/subscription-service";
import { getMessageBusinessBilling } from "@/lib/messaging-billing";
import { mediaUsageFor } from "@/lib/media-service";
import { getPlatformAiConfig } from "@/lib/ai-config";
import {
  getAiGatewayConfig,
  listBusinessGateways,
  refreshKeySpend,
  toPublicBusinessGateway,
} from "@/lib/ai-gateway-service";
import { rialFromGatewayUsd } from "@/lib/ai-gateway";
import { getPlanAllowance } from "@/lib/ai-plan-allowance";
import { query } from "@/lib/db";

/**
 * One business's complete commercial view for the consolidated Billing page
 * (migration 0176): subscription, plan limits, wallet, ledger, entitlements,
 * usage across AI / messaging / media, invoices, payments, overrides and the
 * LiteLLM spend read-back.
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

    const [
      wallet,
      ledger,
      entitlements,
      payments,
      usage,
      gateway,
      platform,
      gatewayRows,
      subscription,
      invoices,
      recurring,
      messageBilling,
      mediaUsage,
      planAllowance,
      overrides,
    ] = await Promise.all([
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
      getBusinessSubscription(businessId),
      listInvoices({ businessId, limit: 50 }),
      calculateSubscriptionTotal(businessId).catch(() => null),
      getMessageBusinessBilling(businessId).catch(() => ({ balanceRial: 0 })),
      mediaUsageFor(businessId).catch(() => ({ totalBytes: 0, assetCount: 0, byKind: {} })),
      getPlanAllowance(businessId),
      query<{
        id: string;
        kind: string;
        target: string;
        value_int: number | null;
        value_bool: boolean | null;
        reason: string;
        expires_at: string | null;
        created_at: string;
        admin_name: string | null;
      }>(
        `SELECT o.id, o.kind, o.target, o.value_int, o.value_bool, o.reason,
                o.expires_at, o.created_at, adm.full_name AS admin_name
           FROM business_billing_overrides o
           LEFT JOIN platform_admins adm ON adm.id = o.created_by
          WHERE o.business_id = $1 AND o.active
          ORDER BY o.created_at DESC`,
        [businessId],
      ),
    ]);

    // The LiteLLM side of this business: each virtual key's reported USD spend,
    // converted to Rial at the platform's stored rate so the console can show
    // the real cost the platform is paying LiteLLM for this business.
    const rate = platform.usdRialRate ?? 0;
    const litellm = {
      costingEnabled: Boolean(platform.gatewayCostingEnabled && rate > 0),
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
      subscription,
      recurring,
      wallet,
      ledger,
      entitlements,
      payments,
      invoices,
      litellm,
      ai: {
        allowance: planAllowance,
        walletSpentRial: usage.rows
          .filter((u) => u.feature_key === "ai")
          .reduce((sum, u) => sum + Number(u.spent_rial), 0),
      },
      messaging: { balanceRial: messageBilling.balanceRial },
      media: { usage: mediaUsage },
      overrides: overrides.rows.map((o) => ({
        id: o.id,
        kind: o.kind,
        target: o.target,
        valueInt: o.value_int,
        valueBool: o.value_bool,
        reason: o.reason,
        expiresAt: o.expires_at,
        createdAt: o.created_at,
        createdBy: o.admin_name,
      })),
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
 * (negative) credits with a note. Every adjustment is audited (§36) with the
 * before/after balance.
 */
export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("adjustments.manage");
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
      const rate = platform.usdRialRate ?? 0;
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
          costingEnabled: Boolean(platform.gatewayCostingEnabled && rate > 0),
          usdRialRate: rate > 0 ? rate : null,
          totalSpendUsd: keys.reduce((s, k) => s + k.spendUsd, 0),
          totalSpendRial: keys.reduce((s, k) => s + k.spendRial, 0),
          keys,
        },
      });
    }

    const amount = Math.floor(Number(body.amountRial ?? 0));
    if (amount === 0 || !Number.isSafeInteger(amount)) {
      return NextResponse.json({ error: "bad_amount" }, { status: 400 });
    }

    try {
      const before = await getWallet(businessId);
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
      await platformAudit({
        adminId: guard.session.padmin,
        businessId,
        action: "wallet.adjusted",
        entity: "business_wallets",
        entityId: businessId,
        payload: {
          amountRial: amount,
          note: body.note?.trim() || null,
          beforeRial: before.balanceRial,
          afterRial: result.balanceRial,
        },
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
