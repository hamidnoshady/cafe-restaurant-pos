import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getWizardProgress, setSetting, SETTING_KEYS } from "@/lib/settings";
import { computeSetupState, requireManager } from "@/lib/setup-state";
import { withTenantScope } from "@/lib/auth";

/** Final step — verifies the required steps and marks the wizard complete. */
export const POST = withTenantScope(async () => {
  const { session, error } = await requireManager();
  if (error) return error;

  const state = await computeSetupState(session.businessId);
  if (state.missingForCompletion.length > 0) {
    return NextResponse.json(
      { error: "incomplete", messages: state.missingForCompletion },
      { status: 409 },
    );
  }

  const progress = await getWizardProgress(session.businessId);
  if (!progress.completedAt) {
    progress.completedAt = new Date().toISOString();
    await setSetting(session.businessId, SETTING_KEYS.wizardProgress, progress);
    await query(
      `INSERT INTO audit_log (business_id, user_id, action, entity)
       VALUES ($1, $2, 'setup.completed', 'business')`,
      [session.businessId, session.sub],
    );
  }

  return NextResponse.json({ ok: true, completedAt: progress.completedAt });
});
