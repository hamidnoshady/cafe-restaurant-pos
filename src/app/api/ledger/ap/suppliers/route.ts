import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { listSupplierBalances } from "@/lib/ap-service";

/** Every supplier with a nonzero AP balance. Same access as the rest of the ledger surface. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  return NextResponse.json({ suppliers: await listSupplierBalances(session.businessId) });
});
