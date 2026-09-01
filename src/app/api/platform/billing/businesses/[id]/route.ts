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

    const [wallet, ledger, entitlements, payments, usage] = await Promise.all([
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
    ]);

    return NextResponse.json({
      business: { id: businessId, name: bizRows[0].name, plan: bizRows[0].plan },
      wallet,
      ledger,
      entitlements,
      payments,
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

    let body: { amountRial?: number; note?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
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
