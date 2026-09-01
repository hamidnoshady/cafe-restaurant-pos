import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getPaymentById, rejectPayment, settlePayment } from "@/lib/wallet-service";
import { activatePurchasedPlan, fulfilPurchasedEntitlement } from "@/lib/billing-service";
import { listPlanFeatures } from "@/lib/billing-plans-service";
import { GatewayError, gatewayErrorMessage } from "@/lib/payment-gateway";

/**
 * Super-admin review of a payment:
 *  - approve → settle (posts the wallet credit) and grants plan/addon
 *    entitlements. Used for manual (bank-transfer) gateway payments; also a
 *    recovery path if a gateway webhook never arrived.
 *  - reject  → marks the payment failed; no money moves.
 * Idempotent: approving an already-verified payment reports back without
 * double-crediting (the wallet's unique payment-id ledger index enforces it).
 */
export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("billing.manage");
    if (guard.error) return guard.error;
    const { id } = await ctx.params;

    let body: { action?: "approve" | "reject" };
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    const action = body.action === "reject" ? "reject" : "approve";

    const payment = await getPaymentById(id);
    if (!payment) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });

    try {
      if (action === "reject") {
        await rejectPayment(id, { platformAdminId: guard.session.padmin });
        return NextResponse.json({ ok: true, status: "failed" });
      }

      if (payment.status !== "verified") {
        await settlePayment(id, {
          gatewayRef: payment.gatewayRef ?? null,
          gatewayStatus: "manual_approved",
          platformAdminId: guard.session.padmin,
        });

        // Fulfil the entitlement a plan/addon purchase paid for.
        const settled = await getPaymentById(id);
        if (settled?.purpose === "addon_purchase" && settled.featureKey) {
          await fulfilPurchasedEntitlement({
            businessId: settled.businessId,
            featureKey: settled.featureKey,
            source: "addon",
          });
        } else if (settled?.purpose === "plan_purchase" && settled.planKey) {
          await activatePurchasedPlan({ businessId: settled.businessId, planKey: settled.planKey });
          const features = await listPlanFeatures(settled.planKey);
          for (const f of features) {
            if (f.pricingModel === "included" || f.pricingModel === "monthly") {
              await fulfilPurchasedEntitlement({
                businessId: settled.businessId,
                featureKey: f.featureKey,
                source: "plan",
                freeUntil: f.freeUntil,
                freeLimit: f.freeLimit,
              });
            }
          }
        }
      }

      const updated = await getPaymentById(id);
      return NextResponse.json({ ok: true, status: updated?.status });
    } catch (err) {
      if (err instanceof GatewayError) {
        return NextResponse.json(
          { error: err.code, message: gatewayErrorMessage(err.code) },
          { status: 400 },
        );
      }
      throw err;
    }
  },
);
