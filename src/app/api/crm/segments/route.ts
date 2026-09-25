import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createSegment, listSegmentsWithCounts } from "@/lib/crm-segments-service";
import { validateSegmentDefinition } from "@/lib/segments";

/**
 * Saved segments (Phase 36).
 *
 * Owner/manager only, both ways. A segment is not a filter on a list — it is
 * the definition of an audience that a later phase will *message*, so creating
 * one is closer to writing a policy than to running a search. The floor's
 * customer work happens on one customer at a time in the directory.
 *
 * The counts come back with the list (`listSegmentsWithCounts`) rather than
 * being fetched per row by the browser: nine segments would otherwise be nine
 * round trips, and the numbers would arrive at nine slightly different moments.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const segments = await listSegmentsWithCounts(session.businessId);
  return NextResponse.json({ segments });
});

interface CreateBody {
  name?: string;
  description?: string;
  definition?: unknown;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmConfigure);
  if (error) return error;

  let body: CreateBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "segment_name_required" }, { status: 400 });

  // Validated here as well as in the service: the service throws (it is the
  // last line of defence for any caller), while a route owes the UI a 400 with
  // the specific Persian-facing code rather than a 500.
  const problems = validateSegmentDefinition(body.definition ?? {});
  if (problems.length > 0) {
    return NextResponse.json({ error: "segment_definition_invalid", problems }, { status: 400 });
  }

  const segment = await createSegment(session.businessId, {
    name,
    description: body.description,
    definition: (body.definition ?? {}) as Parameters<typeof createSegment>[1]["definition"],
    createdBy: session.fullName,
  });
  return NextResponse.json({ segment }, { status: 201 });
});
