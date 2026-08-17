import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import {
  listCommissionRules,
  listSalesStaff,
  upsertCommissionRule,
  type CommissionRuleInput,
} from "@/lib/commission-service";

/** The business's commission rules (all employees) plus the staff picker for the editor. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const [rules, staff] = await Promise.all([
    listCommissionRules(session.businessId, undefined, true),
    listSalesStaff(session.businessId),
  ]);
  return NextResponse.json({ rules, staff });
});

/** Creates one commission rule for a selling employee. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: CommissionRuleInput;
  try {
    body = (await request.json()) as CommissionRuleInput;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!body.employeeId || !body.kind || !body.basis) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const rule = await upsertCommissionRule(session.businessId, body);
    return NextResponse.json({ ok: true, rule });
  } catch (err) {
    return NextResponse.json({ error: "validation_failed", message: (err as Error).message }, { status: 400 });
  }
});
