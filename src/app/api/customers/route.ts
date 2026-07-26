import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { createCustomer, searchCustomers } from "@/lib/customers-service";

/** Search customers by name/phone (checkout's credit-payment picker). Business-wide, like the chart of accounts. */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;

  const q = request.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json({ customers: await searchCustomers(session.businessId, q) });
});

interface CreateBody {
  name?: string;
  phone?: string;
}

/** Creates a customer inline from checkout — the same trust boundary as taking a payment. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier");
  if (error) return error;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });

  const customer = await createCustomer(session.businessId, { name, phone: body.phone });
  return NextResponse.json({ customer }, { status: 201 });
});
