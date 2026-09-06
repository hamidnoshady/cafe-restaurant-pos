import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PartyValidationError, updatePartyCategory } from "@/lib/parties-service";
import { PARTY_ROLES, type PartyRole } from "@/lib/parties";

/**
 * Renames, reorders or deactivates one category.
 *
 * No DELETE here on purpose: `removePartyCategory` keeps a category that parties
 * still point at (deactivating it instead) precisely so a grouping people use does
 * not vanish from their records because someone clicked trash. That decision
 * belongs to the directory's category panel, where the count of parties using it
 * is on screen — not to a bare HTTP verb that cannot show it.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
    if (error) return error;

    let body: { name?: string; role?: string | null; sortOrder?: number; isActive?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (body.name !== undefined) {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "category_name_required" }, { status: 400 });
      if (name.length > 80) return NextResponse.json({ error: "category_name_too_long" }, { status: 400 });
    }
    let role: PartyRole | null | undefined;
    if (body.role !== undefined) {
      if (body.role === null) role = null;
      else {
        const found = PARTY_ROLES.find((candidate) => candidate.toLowerCase() === String(body.role).trim().toLowerCase());
        if (!found) return NextResponse.json({ error: "invalid_role" }, { status: 400 });
        role = found as PartyRole;
      }
    }

    const { id } = await params;
    try {
      const category = await updatePartyCategory(session.businessId, id, {
        name: body.name,
        role,
        sortOrder: body.sortOrder,
        isActive: body.isActive,
      });
      if (!category) return NextResponse.json({ error: "category_not_found" }, { status: 404 });
      return NextResponse.json({ category });
    } catch (err) {
      if (err instanceof PartyValidationError) {
        return NextResponse.json(
          { error: err.code, fieldErrors: err.field ? { [err.field]: err.code } : undefined },
          { status: 409 },
        );
      }
      throw err;
    }
  },
);
