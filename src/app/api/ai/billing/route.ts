import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { getPlatformAiConfig, isPlatformAiConfigured } from "@/lib/ai-config";
import {
  createAiTopUpRequest,
  getAiBusinessBilling,
  listRecentAiLedger,
} from "@/lib/ai-billing-service";
import { requireManager } from "@/lib/setup-state";

/** Business-facing credit balance, history, catalogue and top-up request flow. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const [billing, ledger, config] = await Promise.all([
    getAiBusinessBilling(session.businessId),
    listRecentAiLedger(session.businessId),
    getPlatformAiConfig(),
  ]);

  return NextResponse.json({
    billing,
    ledger,
    // Deliberately only the display unit and availability state. Provider,
    // model, endpoint and all secrets stay platform-admin-only.
    creditUnitRial: config.creditUnitRial,
    providerReady: isPlatformAiConfigured(config),
  });
});

/** Submit a top-up request for a specific credit amount (Rial). */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { amountRial?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const amount = typeof body.amountRial === "number" ? Math.floor(body.amountRial) : 0;
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, 1_000) : undefined;
  if (!Number.isSafeInteger(amount) || amount < 1) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const topUp = await createAiTopUpRequest({
      businessId: session.businessId,
      amountRial: amount,
      note,
    });
    return NextResponse.json({ topUp }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.message === "invalid_amount") {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    throw err;
  }
});
