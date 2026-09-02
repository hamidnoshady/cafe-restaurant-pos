import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  createCustomer,
  listCustomers,
  searchCustomers,
  MAX_CUSTOMER_ADDRESS,
  MAX_CUSTOMER_NAME,
  MAX_CUSTOMER_NOTES,
  MAX_CUSTOMER_PHONE,
} from "@/lib/customers-service";

/**
 * `q` alone (no `page`) is the checkout credit-payment picker's search — kept
 * capped at 20, active customers only, for backward compatibility. Passing
 * `page`/`pageSize` switches to the paginated directory listing the
 * customers management page uses, which can also include inactive customers.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.customersView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const q = params.get("q") ?? "";
  if (!params.has("page") && !params.has("pageSize") && !params.has("includeInactive")) {
    return NextResponse.json({ customers: await searchCustomers(session.businessId, q) });
  }

  const { customers, total } = await listCustomers(session.businessId, {
    q,
    includeInactive: params.get("includeInactive") === "1" || params.get("includeInactive") === "true",
    page: params.has("page") ? Number(params.get("page")) : undefined,
    pageSize: params.has("pageSize") ? Number(params.get("pageSize")) : undefined,
  });
  return NextResponse.json({ customers, total });
});

interface CreateBody {
  name?: string;
  phone?: string;
  address?: string;
  notes?: string;
}

/** Creates a customer — from checkout's inline picker or the customers directory page. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.customersManage);
  if (error) return error;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name_required" }, { status: 400 });
  if (name.length > MAX_CUSTOMER_NAME) return NextResponse.json({ error: "name_too_long" }, { status: 400 });

  const phone = body.phone?.trim() || undefined;
  if (phone && phone.length > MAX_CUSTOMER_PHONE) {
    return NextResponse.json({ error: "phone_too_long" }, { status: 400 });
  }
  const address = body.address?.trim() || undefined;
  if (address && address.length > MAX_CUSTOMER_ADDRESS) {
    return NextResponse.json({ error: "address_too_long" }, { status: 400 });
  }
  const notes = body.notes?.trim() || undefined;
  if (notes && notes.length > MAX_CUSTOMER_NOTES) {
    return NextResponse.json({ error: "notes_too_long" }, { status: 400 });
  }

  const customer = await createCustomer(session.businessId, { name, phone, address, notes });
  return NextResponse.json({ customer }, { status: 201 });
});
