import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { isUuid } from "@/lib/uuid";
import { linkParties, relationshipsFor, unlinkParties } from "@/lib/crm-relationship-service";

/**
 * A customer's relationship graph — «ارتباط‌ها».
 *
 * Reading is `crm.view`; editing is `crm.manage`. Relationships are ordinary
 * business data, not a privacy boundary: the edge itself carries no personal
 * detail beyond the two names, both of which the reader can already see.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

    return NextResponse.json({ relationships: await relationshipsFor(session.businessId, id) });
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let body: {
      toPartyId?: unknown;
      kind?: unknown;
      roleTitle?: unknown;
      isPrimary?: unknown;
      note?: unknown;
      direction?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const other = typeof body.toPartyId === "string" ? body.toPartyId : "";
    if (!isUuid(other)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    // The screen is always on one party's file, but an edge reads in a
    // direction — «علی مخاطب شرکت الف است» is not «شرکت الف مخاطب علی است».
    // `direction: "incoming"` lets the company's file add its contact without
    // the client having to reverse the ids and get it backwards.
    const incoming = body.direction === "incoming";

    const result = await linkParties(
      session.businessId,
      {
        fromPartyId: incoming ? other : id,
        toPartyId: incoming ? id : other,
        kind: String(body.kind ?? ""),
        roleTitle: typeof body.roleTitle === "string" ? body.roleTitle : undefined,
        isPrimary: body.isPrimary === true,
        note: typeof body.note === "string" ? body.note : undefined,
      },
      { name: session.fullName, userId: session.sub },
    );

    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ id: result.id }, { status: 201 });
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const relationshipId = request.nextUrl.searchParams.get("relationshipId") ?? "";
    if (!isUuid(relationshipId)) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const removed = await unlinkParties(session.businessId, relationshipId, {
      name: session.fullName,
      userId: session.sub,
    });
    if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
