import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listSupplierBalances, listSupplierDirectory } from "@/lib/ap-service";

/**
 * `?scope=directory` → every supplier record with its balance (what a picker
 * needs); default → only suppliers with a nonzero A/P balance, plus the
 * unattributed bucket (what the A/P report shows). The mirror of
 * `/api/ledger/ar/customers`.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  if (request.nextUrl.searchParams.get("scope") === "directory") {
    return NextResponse.json({ suppliers: await listSupplierDirectory(session.businessId) });
  }
  return NextResponse.json({ suppliers: await listSupplierBalances(session.businessId) });
});
