import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listStaffWages } from "@/lib/payroll-service";

/**
 * Wages are compensation data — restricted to owner + accountant, not the
 * usual owner/manager/accountant that gates the rest of this phase's ledger
 * surfaces. Managers don't see or set staff wage amounts.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "accountant");
  if (error) return error;

  const staff = await listStaffWages(session.businessId);
  return NextResponse.json({ staff });
});
