import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { recomputeRfm, scoredPopulation } from "@/lib/crm-service";
import { recordManualScoringRun, scoringFreshness } from "@/lib/crm-scoring-freshness";

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
 *
 * The button is no longer the only way scores get updated: a background tick
 * rescores dirty businesses and refreshes everyone daily
 * (`crm-scoring-freshness.ts`). `GET` returns how old the numbers are so the
 * screen can label them, because a score presented as current when it is two
 * days old is a lie the reader has no way to detect.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const [scores, freshness] = await Promise.all([
    scoredPopulation(session.businessId),
    scoringFreshness(session.businessId),
  ]);
  return NextResponse.json({ scores, freshness });
});

export const POST = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  // Stamped before the scan: this run accounts for everything dirty as of now
  // and nothing that arrives while it is working.
  const runStartedAt = new Date();
  const result = await recomputeRfm(session.businessId);
  // Records the run and clears the dirty flag it satisfied, so the background
  // tick does not redo the identical scan minutes later.
  await recordManualScoringRun(session.businessId, result.scored, runStartedAt);
  return NextResponse.json({ result, freshness: await scoringFreshness(session.businessId) });
});
