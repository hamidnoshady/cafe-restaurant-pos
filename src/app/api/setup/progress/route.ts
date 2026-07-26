import { NextRequest, NextResponse } from "next/server";
import { markStepDone } from "@/lib/settings";
import { OPTIONAL_STEPS, requireManager, WIZARD_STEPS, type WizardStep } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/**
 * Marks a skippable step as done (users / hardware / opening can be skipped;
 * required steps are only marked by their own endpoints).
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireManager();
  if (error) return error;

  let body: { step?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const step = body.step as WizardStep | undefined;
  if (!step || !WIZARD_STEPS.includes(step) || !OPTIONAL_STEPS.includes(step)) {
    return NextResponse.json({ error: "invalid_step" }, { status: 400 });
  }

  const progress = await markStepDone(session.businessId, step);
  return NextResponse.json({ ok: true, progress });
});
