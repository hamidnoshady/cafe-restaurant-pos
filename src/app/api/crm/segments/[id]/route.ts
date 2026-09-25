import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  archiveSegment,
  getSegment,
  resolveSegment,
  updateSegment,
} from "@/lib/crm-segments-service";
import {
  isSegmentPurpose,
  validateSegmentDefinition,
  type SegmentPurpose,
} from "@/lib/segments";

/**
 * One saved segment (Phase 36).
 *
 * `GET ?members=1` resolves the audience. `purpose` is **required** to be
 * explicit there and defaults to `view`: a caller that forgets to say why it
 * wants the list gets the on-screen list, never a sending list. Asking for
 * `sms`/`email` applies the consent predicate in SQL, so an un-consented
 * customer is not merely hidden by the UI — they are not in the result at all.
 */
export const GET = withTenantScope(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const { id } = await params;
    const segment = await getSegment(session.businessId, id);
    if (!segment)
      return NextResponse.json({ error: "segment_not_found" }, { status: 404 });

    const search = request.nextUrl.searchParams;
    if (search.get("members") !== "1") return NextResponse.json({ segment });

    const requested = search.get("purpose") ?? "view";
    if (!isSegmentPurpose(requested)) {
      return NextResponse.json(
        { error: "segment_purpose_invalid" },
        { status: 400 },
      );
    }
    const purpose: SegmentPurpose = requested;
    const limitParam = Number(search.get("limit"));
    const members = await resolveSegment(session.businessId, id, {
      purpose,
      limit:
        Number.isFinite(limitParam) && limitParam > 0
          ? Math.min(limitParam, 5000)
          : 1000,
    });
    return NextResponse.json({ segment, members, purpose });
  },
);

interface UpdateBody {
  name?: string;
  description?: string;
  definition?: unknown;
  archived?: boolean;
}

export const PATCH = withTenantScope(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
    if (error) return error;

    let body: UpdateBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (body.name !== undefined && !body.name.trim()) {
      return NextResponse.json(
        { error: "segment_name_required" },
        { status: 400 },
      );
    }
    if (body.definition !== undefined) {
      const problems = validateSegmentDefinition(body.definition);
      if (problems.length > 0) {
        return NextResponse.json(
          { error: "segment_definition_invalid", problems },
          { status: 400 },
        );
      }
    }

    const { id } = await params;
    const segment = await updateSegment(session.businessId, id, {
      name: body.name,
      description: body.description,
      definition: body.definition as Parameters<
        typeof updateSegment
      >[2]["definition"],
      archived: body.archived,
    });
    if (!segment)
      return NextResponse.json({ error: "segment_not_found" }, { status: 404 });
    return NextResponse.json({ segment });
  },
);

/**
 * Archives a segment; it is never deleted.
 *
 * A segment that was used to pick an audience is part of the record of *why*
 * someone was contacted, which is exactly the question a consent complaint
 * asks months later. Archiving hides it from the builder and keeps the answer.
 */
export const DELETE = withTenantScope(
  async (
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
    if (error) return error;

    const { id } = await params;
    const archived = await archiveSegment(session.businessId, id);
    if (!archived)
      return NextResponse.json({ error: "segment_not_found" }, { status: 404 });
    return NextResponse.json({ result: "archived" });
  },
);
