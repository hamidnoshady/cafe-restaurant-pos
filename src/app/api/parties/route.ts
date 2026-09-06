import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PartyValidationError, createParty, listParties, searchParties } from "@/lib/parties-service";
import { PARTY_ROLES, parsePartyRequestBody, type PartyRole } from "@/lib/parties";

/**
 * The party directory — one endpoint for «طرف‌حساب‌ها» in every app.
 *
 * This is where the platform's copy of the record lives, and it is deliberately
 * the *only* way a party is written (migration 0137 renamed `customers` to
 * `parties`; the old `/api/customers` is gone rather than aliased, because a second
 * door is how two screens end up disagreeing about one person).
 *
 * Each app asks for the slice its own job needs — `role=Customer` for the CRM and
 * the checkout picker, `role=Supplier` for the store, `role=Employee` for the team —
 * and that filter is a *view*, not a permission: whoever can read a party can read
 * all three roles, so the server does not need to pretend a query parameter is a
 * gate. The gate is `parties.view`, and the money-shaped fields have their own, one
 * level down (`touchesAccountingFields` here, `accountingFieldsIn` on the item
 * route).
 *
 * `q` alone (no `page`) is the checkout credit-payment picker's search — kept
 * capped at 20, active parties only, for backward compatibility. Passing
 * `page`/`pageSize` switches to the paginated directory listing the party screens
 * use, which can also include archived parties.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const q = params.get("q") ?? "";
  const rolesOrError = rolesFrom(params);
  if (typeof rolesOrError === "string") return NextResponse.json({ error: rolesOrError }, { status: 400 });
  const roles = rolesOrError;

  if (!params.has("page") && !params.has("pageSize") && !params.has("includeInactive")) {
    const parties = await searchParties(session.businessId, q, {
      roles,
      limit: params.get("limit") ? Number(params.get("limit")) : undefined,
    });
    return NextResponse.json({ parties, customers: parties });
  }

  const { parties, total } = await listParties(session.businessId, {
    q,
    roles,
    includeInactive: params.get("includeInactive") === "1" || params.get("includeInactive") === "true",
    categoryId: params.get("categoryId") || undefined,
    page: params.has("page") ? Number(params.get("page")) : undefined,
    pageSize: params.has("pageSize") ? Number(params.get("pageSize")) : undefined,
  });
  // `customers` is kept beside `parties` for the screens that predate the rename
  // and read only the customer slice: a list endpoint that returns the same array
  // under one more name is not a second source of truth, and it means no caller is
  // ever asked to guess which key is live.
  // `businessId` is what the directory namespaces its local drafts by, and it is
  // already in the session this route read: the origin names the tenant, and no
  // other business's row can appear here to be leaked by it.
  return NextResponse.json({ parties, customers: parties, total, businessId: session.businessId });
});

/** `?role=Supplier&role=Employee` or `?role=Customer`; anything else is a 400. */
function rolesFrom(params: URLSearchParams): PartyRole[] | "invalid_role" | undefined {
  const raw = [...params.getAll("role"), ...(params.get("roles")?.split(",") ?? [])]
    .map((value) => value.trim())
    .filter(Boolean);
  if (raw.length === 0) return undefined;
  const out: PartyRole[] = [];
  for (const value of raw) {
    const found = PARTY_ROLES.find((role) => role.toLowerCase() === value.toLowerCase());
    if (!found) return "invalid_role";
    if (!out.includes(found)) out.push(found);
  }
  return out;
}

/**
 * Whether this write touches the ledger's numbers.
 *
 * The accounting code, the tax rate and the bank details decide what a business
 * posts to a party's ledger account, so `parties.manage` — which a manager and a
 * cashier both hold — is not enough to change them. The owner who wants a till
 * operator editing party phone numbers should not be silently giving that till an
 * invoice's VAT rate with it.
 */
function touchesAccountingFields(body: Record<string, unknown>): boolean {
  if (body.accountingCode !== undefined || body.accountingCodeMode !== undefined) return true;
  const general = (body.general_info ?? body.generalInfo) as Record<string, unknown> | undefined;
  if (general && general.taxPercentage !== undefined) return true;
  if (general && (general.nationalId !== undefined || general.economicCode !== undefined)) return true;
  return body.financial_info !== undefined || body.financialInfo !== undefined;
}

/**
 * Creates a party — from the directory's «افزودن طرف‌حساب», from a store adding a
 * supplier, or from checkout's inline picker.
 *
 * The body is the flat form state at the root and one nested object per tab (see
 * `buildPartyPayload`); the route answers "what is wrong with it" with the field
 * path, so the form can put the message under the input that caused it.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesView);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (touchesAccountingFields(body)) {
    const { error: ledgerError } = await requirePermission(PERMISSIONS.ledgerView);
    if (ledgerError) return ledgerError;
  }
  const manage = await requirePermission(PERMISSIONS.partiesManage);
  if (manage.error) return manage.error;

  const { input, errors } = parsePartyRequestBody(body);
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "validation_failed", fieldErrors: errors }, { status: 400 });
  }

  try {
    const party = await createParty(session.businessId, input, {
      locationId: session.locationId ?? null,
    });
    return NextResponse.json({ party, customer: party }, { status: 201 });
  } catch (err) {
    if (err instanceof PartyValidationError) {
      return NextResponse.json(
        { error: err.code, fieldErrors: err.field ? { [err.field]: err.code } : undefined },
        { status: 409 },
      );
    }
    throw err;
  }
});
