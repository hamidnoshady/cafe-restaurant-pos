import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireRole, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteCase, getCase } from "@/lib/crm-service";

/** One service case. */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesView);
    if (error) return error;

    const { id } = await params;
    const record = await getCase(session.businessId, id);
    if (!record) return NextResponse.json({ error: "case_not_found" }, { status: 404 });
    return NextResponse.json({ case: record });
  },
);

/**
 * Deletes a case — owner/manager only, unlike the rest of the case surface.
 *
 * Everything else here is floor work, but a complaint is the evidence that a
 * complaint was made. Closing one is the floor's job (`POST` with
 * `status: "closed"`); making it never have existed is not.
 */
export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requireRole("owner", "manager");
    if (error) return error;

    const { id } = await params;
    const deleted = await deleteCase(session.businessId, id);
    if (!deleted) return NextResponse.json({ error: "case_not_found" }, { status: 404 });
    return NextResponse.json({ result: "deleted" });
  },
);
