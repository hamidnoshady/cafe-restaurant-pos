import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { previewSegment } from "@/lib/crm-segments-service";
import { isSendingPurpose, validateSegmentDefinition, type SegmentPurpose } from "@/lib/segments";

/**
 * Count and sample an *unsaved* definition — what the builder shows while the
 * owner is still typing (Phase 36).
 *
 * A POST despite being a read: the definition is a JSON document that would not
 * survive a query string, and putting audience rules in a URL would drop them
 * into every access log. Nothing is written.
 *
 * The response carries `totalBeforeConsent` next to `count`, so the builder can
 * say «۱۲۰ نفر، ۴۵ نفر با اجازهٔ پیامک» instead of quietly showing the smaller
 * number and leaving the owner to wonder why the segment shrank.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { definition?: unknown; purpose?: string; sampleSize?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const problems = validateSegmentDefinition(body.definition ?? {});
  if (problems.length > 0) {
    return NextResponse.json({ error: "segment_definition_invalid", problems }, { status: 400 });
  }

  const requested = body.purpose ?? "view";
  const purpose: SegmentPurpose =
    requested === "view" || isSendingPurpose(requested as SegmentPurpose)
      ? (requested as SegmentPurpose)
      : "view";

  const preview = await previewSegment(
    session.businessId,
    (body.definition ?? {}) as Parameters<typeof previewSegment>[1],
    { purpose, sampleSize: body.sampleSize },
  );
  return NextResponse.json({ preview });
});
