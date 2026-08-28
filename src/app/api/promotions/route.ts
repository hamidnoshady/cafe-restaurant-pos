import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listPromotionCatalogue, upsertPromotion, type PromotionInput } from "@/lib/promotions-service";

/**
 * The business's promotions, as the management catalogue (Phase 36b): full
 * rows — name, is_active, the date window — so the Growth app's campaigns
 * screen can label, order and pause them. The engine's own callers read
 * `listPromotions` server-side and never through this route.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;
  return NextResponse.json({ promotions: await listPromotionCatalogue(session.businessId) });
});

/** Creates or edits one promotion. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: PromotionInput;
  try {
    body = (await request.json()) as PromotionInput;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.name?.trim()) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const promotion = await upsertPromotion(session.businessId, body);
    return NextResponse.json({ ok: true, promotion });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
