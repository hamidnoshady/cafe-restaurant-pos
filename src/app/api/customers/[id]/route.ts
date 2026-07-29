import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getCustomer, removeCustomer, updateCustomer } from "@/lib/customers-service";

export const GET = withTenantScope(async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.customersView);
  if (error) return error;

  const { id } = await params;
  const customer = await getCustomer(session.businessId, id);
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  return NextResponse.json({ customer });
});

interface UpdateBody {
  name?: string;
  phone?: string | null;
  address?: string | null;
  notes?: string | null;
  isActive?: boolean;
}

export const PUT = withTenantScope(async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.customersManage);
  if (error) return error;

  let body: UpdateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: "name_required" }, { status: 400 });
  }

  const { id } = await params;
  const customer = await updateCustomer(session.businessId, id, body);
  if (!customer) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  return NextResponse.json({ customer });
});

/**
 * Removes a customer. Returns which happened: `deleted` (no financial
 * history — the row is gone) or `archived` (has orders/AR receipts — kept for
 * the ledger's sake, just hidden from checkout and default listings). See
 * removeCustomer's doc comment in customers-service.ts.
 */
export const DELETE = withTenantScope(async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.customersManage);
  if (error) return error;

  const { id } = await params;
  const result = await removeCustomer(session.businessId, id);
  if (result === "not_found") return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
  return NextResponse.json({ result });
});
