import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PartyValidationError, createPartyCategory, listPartyCategories } from "@/lib/parties-service";
import { PARTY_ROLES, type PartyRole } from "@/lib/parties";

/**
 * The party categories — the reference table `parties.category_id` points at.
 *
 * Deliberately a child of the parties API rather than a Settings tab: grouping
 * counterparties is part of maintaining them, and «تنظیمات» already has seventeen
 * tabs, none of which owns a list of people. `role` narrows a category to one kind
 * of counterparty so the supplier form cannot offer a grouping invented for
 * personnel; a category with no role is offered to all three.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesView);
  if (error) return error;

  const raw = request.nextUrl.searchParams.get("role");
  const role = raw
    ? (PARTY_ROLES.find((candidate) => candidate.toLowerCase() === raw.trim().toLowerCase()) as PartyRole | undefined)
    : undefined;
  if (raw && !role) return NextResponse.json({ error: "invalid_role" }, { status: 400 });

  const categories = await listPartyCategories(session.businessId, {
    role: role ?? null,
    includeInactive: request.nextUrl.searchParams.get("includeInactive") === "1",
  });
  return NextResponse.json({ categories });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
  if (error) return error;

  let body: { name?: string; role?: string | null; sortOrder?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim() ?? "";
  if (!name) return NextResponse.json({ error: "category_name_required" }, { status: 400 });
  if (name.length > 80) return NextResponse.json({ error: "category_name_too_long" }, { status: 400 });

  try {
    const category = await createPartyCategory(session.businessId, { name, role: body.role ? (body.role as PartyRole) : null, sortOrder: body.sortOrder });
    if (!category) return NextResponse.json({ error: "category_name_required" }, { status: 400 });
    return NextResponse.json({ category }, { status: 201 });
  } catch (err) {
    if (err instanceof PartyValidationError) {
      return NextResponse.json({ error: err.code, fieldErrors: err.field ? { [err.field]: err.code } : undefined }, { status: 409 });
    }
    throw err;
  }
});
