import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import {
  createPayment,
  getPaymentConfig,
  listCreditPackages,
  listPayments,
  startPayment,
} from "@/lib/wallet-service";
import { listBillingPlans, listPlanFeatures } from "@/lib/billing-plans-service";
import { GatewayError, gatewayErrorMessage } from "@/lib/payment-gateway";

/**
 * The business's own payments (top-ups and purchases), newest first.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const [payments, config] = await Promise.all([
    listPayments({ businessId: session.businessId, limit: 100 }),
    getPaymentConfig(),
  ]);
  return NextResponse.json({ payments, gateway: config.gateway });
});

/**
 * Create + start a payment.
 *
 * Body:
 *  { kind: "topup", packageId }                      → credit package top-up
 *  { kind: "topup", amountRial }                     → custom top-up (credit == amount)
 *  { kind: "plan", planKey }                         → plan monthly fee purchase
 *  { kind: "addon", featureKey }                     → one-off feature purchase
 *
 * Returns { redirectUrl } to send the browser to the gateway, or null for the
 * manual gateway (payment waits for admin approval).
 */
export const POST = withTenantScope(async (req: Request) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const kind = String(body.kind ?? "topup");
  try {
    let payment: { id: string; amountRial: number };
    let description: string;

    if (kind === "topup") {
      const packages = await listCreditPackages(true);
      const pkg = packages.find((p) => p.id === body.packageId);
      if (pkg) {
        payment = await createPayment({
          businessId: session.businessId,
          purpose: "top_up",
          amountRial: pkg.priceRial,
          creditRial: pkg.creditRial,
          packageId: pkg.id,
          description: `شارژ اعتبار: ${pkg.name}`,
          userId: session.sub,
        });
        description = `شارژ اعتبار: ${pkg.name}`;
      } else {
        const amount = Math.floor(Number(body.amountRial ?? 0));
        if (!Number.isSafeInteger(amount) || amount < 100_000) {
          return NextResponse.json({ error: "bad_amount" }, { status: 400 });
        }
        payment = await createPayment({
          businessId: session.businessId,
          purpose: "top_up",
          amountRial: amount,
          creditRial: amount,
          description: "شارژ اعتبار (مبلغ دلخواه)",
          userId: session.sub,
        });
        description = "شارژ اعتبار (مبلغ دلخواه)";
      }
    } else if (kind === "plan") {
      const plans = await listBillingPlans(true);
      const plan = plans.find((p) => p.key === body.planKey);
      if (!plan || plan.monthlyPriceRial == null) {
        return NextResponse.json({ error: "plan_not_found" }, { status: 404 });
      }
      payment = await createPayment({
        businessId: session.businessId,
        purpose: "plan_purchase",
        amountRial: plan.monthlyPriceRial,
        creditRial: 0,
        planKey: plan.key,
        description: `اشتراک پلن «${plan.name}»`,
        userId: session.sub,
      });
      description = `اشتراک پلن «${plan.name}»`;
    } else if (kind === "addon") {
      const featureKey = String(body.featureKey ?? "");
      const { query } = await import("@/lib/db");
      const { rows: bizRows } = await query<{ plan: string }>(
        `SELECT plan FROM businesses WHERE id = $1`,
        [session.businessId],
      );
      const currentPlanKey = bizRows[0]?.plan ?? "free";
      const features = await listPlanFeatures(currentPlanKey);
      const feature = features.find((f) => f.featureKey === featureKey && f.pricingModel === "addon");
      if (!feature) {
        return NextResponse.json({ error: "addon_not_found" }, { status: 404 });
      }
      payment = await createPayment({
        businessId: session.businessId,
        purpose: "addon_purchase",
        amountRial: feature.priceRial,
        creditRial: 0,
        featureKey: feature.featureKey,
        planKey: currentPlanKey,
        description: `خرید قابلیت «${feature.featureName ?? feature.featureKey}»`,
        userId: session.sub,
      });
      description = `خرید قابلیت «${feature.featureName ?? feature.featureKey}»`;
    } else {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    void description;
    const started = await startPayment(payment.id);
    return NextResponse.json({ paymentId: payment.id, redirectUrl: started.redirectUrl, gateway: started.gateway });
  } catch (err) {
    if (err instanceof GatewayError) {
      return NextResponse.json(
        { error: err.code, message: gatewayErrorMessage(err.code) },
        { status: 502 },
      );
    }
    const code = err instanceof Error ? err.message : "internal_error";
    return NextResponse.json({ error: code }, { status: 400 });
  }
});
