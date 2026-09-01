import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { getPaymentById, verifyPayment } from "@/lib/wallet-service";
import { activatePurchasedPlan, fulfilPurchasedEntitlement } from "@/lib/billing-service";
import { listPlanFeatures } from "@/lib/billing-plans-service";
import { GatewayError, gatewayErrorMessage } from "@/lib/payment-gateway";

/**
 * Gateway return (Zarinpal redirects the browser here with ?Authority&Status;
 * our callback adds ?payment=<uuid>). The return page calls this route; it is
 * idempotent — verifying an already-settled payment returns its record.
 *
 * After a verified plan/addon purchase the matching entitlement is recorded so
 * the feature unlocks immediately.
 */
export const POST = withTenantScope(async (req: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { paymentId?: string; authority?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const paymentId = String(body.paymentId ?? "");
  const authority = String(body.authority ?? "");
  const status = String(body.status ?? "");
  if (!paymentId) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  const existing = await getPaymentById(paymentId);
  if (!existing || existing.businessId !== session.businessId) {
    return NextResponse.json({ error: "payment_not_found" }, { status: 404 });
  }

  try {
    // Already verified (user refreshed the return page) — just report state.
    if (existing.status !== "verified") {
      await verifyPayment({ paymentId, authority, status });
    }
    const payment = await getPaymentById(paymentId);
    if (!payment) return NextResponse.json({ error: "payment_not_found" }, { status: 404 });

    // Grant the entitlement a plan/addon purchase paid for.
    if (payment.status === "verified" && payment.purpose !== "top_up") {
      if (payment.purpose === "addon_purchase" && payment.featureKey) {
        await fulfilPurchasedEntitlement({
          businessId: session.businessId,
          featureKey: payment.featureKey,
          source: "addon",
        });
      } else if (payment.purpose === "plan_purchase" && payment.planKey) {
        // Switch the business onto the purchased plan so its plan-builder
        // prices become the ones it is billed at, and stamp the plan's
        // included/monthly features as owned via plan.
        await activatePurchasedPlan({ businessId: session.businessId, planKey: payment.planKey });
        const features = await listPlanFeatures(payment.planKey);
        for (const f of features) {
          if (f.pricingModel === "included" || f.pricingModel === "monthly") {
            await fulfilPurchasedEntitlement({
              businessId: session.businessId,
              featureKey: f.featureKey,
              source: "plan",
              freeUntil: f.freeUntil,
              freeLimit: f.freeLimit,
            });
          }
        }
      }
    }

    return NextResponse.json({
      payment: {
        id: payment.id,
        status: payment.status,
        amountRial: payment.amountRial,
        creditRial: payment.creditRial,
        gatewayRef: payment.gatewayRef,
        purpose: payment.purpose,
      },
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      return NextResponse.json(
        { error: err.code, message: gatewayErrorMessage(err.code) },
        { status: 502 },
      );
    }
    throw err;
  }
});
