import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { recomputeRfm, scoredPopulation } from "@/lib/crm-service";

/**
 * RFM scores and lifecycle stages (Phase 36).
 *
 * `GET` reads the stored scores; `POST` recomputes them for the whole customer
 * base.
 *
 * Recomputing is an explicit act rather than a read-time calculation because
 * quintiles are a **whole-population** property: a customer's score only means
 * anything relative to everyone else's, so scoring one customer on demand is
 * not a meaningful operation. Storing them also keeps the number stable while
 * an owner is looking at it — a stage that silently changed between two page
 * loads would be worse than a stage that is a day old.
 *
 * A null score means "not scored yet", never zero. A business that has never
 * pressed the button sees an empty state, not a customer base of ones.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  return NextResponse.json({ scores: await scoredPopulation(session.businessId) });
});

export const POST = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const result = await recomputeRfm(session.businessId);
  return NextResponse.json({ result });
});
