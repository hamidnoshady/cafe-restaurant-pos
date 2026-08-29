import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { customerTimeline } from "@/lib/customer-timeline-service";

/**
 * One customer's history, merged from every app that touched them (Phase 36).
 *
 * Gated on `customers.view` rather than a role: reading one customer's history
 * is the floor's work — the person on the phone needs to know when the last
 * order was and what the complaint was about — and that is exactly the
 * permission the directory already requires.
 *
 * `kinds` filters the merge server-side, so the filter chips do not ship rows
 * the page then throws away.
 */
export const GET = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.customersView);
    if (error) return error;

    const { id } = await params;
    const search = request.nextUrl.searchParams;
    const limitParam = Number(search.get("limit"));
    const kinds = search.get("kinds");

    const events = await customerTimeline(session.businessId, id, {
      limit: Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : undefined,
      kinds: kinds ? kinds.split(",").map((kind) => kind.trim()).filter(Boolean) : undefined,
    });
    return NextResponse.json({ events });
  },
);
