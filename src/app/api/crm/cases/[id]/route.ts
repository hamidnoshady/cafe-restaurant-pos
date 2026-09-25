import { NextRequest, NextResponse } from "next/server";
import {requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { deleteCase, getCase } from "@/lib/crm-service";
import { setCaseStatus } from "@/lib/crm-case-service";

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
    const { session, error } = await requirePermission(PERMISSIONS.crmDelete);
    if (error) return error;

    const { id } = await params;
    const deleted = await deleteCase(session.businessId, id);
    if (!deleted) return NextResponse.json({ error: "case_not_found" }, { status: 404 });
    return NextResponse.json({ result: "deleted" });
  },
);

/**
 * Move a case to another status.
 *
 * Separate from the case upsert because a status change is not a field edit:
 * it starts and stops the response clock, closes out accumulated waiting time,
 * stamps the first response, and writes a history event. Routing it through a
 * generic "save the whole case" would lose all of that the first time a UI
 * submitted a form with the status field in it.
 *
 * Floor-accessible, like the rest of the case surface — the person who hears
 * back from the customer is the person who should be able to take the case off
 * `waiting`.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesView);
    if (error) return error;

    let body: { status?: string; comment?: string; isInternal?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body.status) {
      return NextResponse.json({ error: "case_status_invalid" }, { status: 400 });
    }

    const { id } = await params;
    const result = await setCaseStatus(
      session.businessId,
      id,
      body.status,
      { name: session.fullName, userId: session.sub },
      { comment: body.comment, isInternal: body.isInternal },
    );

    if (!result.ok) {
      // `same_status` is a no-op rather than a failure — a double-submitted
      // form should leave the user looking at the case, not at a red banner
      // for having changed nothing.
      if (result.error === "same_status") {
        return NextResponse.json({ case: await getCase(session.businessId, id) });
      }
      const status = result.error === "not_found" ? 404 : 400;
      return NextResponse.json({ error: result.error }, { status });
    }

    return NextResponse.json({
      case: await getCase(session.businessId, id),
      sla: result.sla,
    });
  },
);
