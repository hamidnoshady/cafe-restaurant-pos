import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { completeActivity, deleteActivity, getActivity } from "@/lib/crm-service";

/** One activity. `PATCH { completed }` is the tick-box; that is the only field a list needs to change. */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.customersView);
    if (error) return error;

    const { id } = await params;
    const activity = await getActivity(session.businessId, id);
    if (!activity) return NextResponse.json({ error: "activity_not_found" }, { status: 404 });
    return NextResponse.json({ activity });
  },
);

export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.customersManage);
    if (error) return error;

    let body: { completed?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof body.completed !== "boolean") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const { id } = await params;
    const updated = await completeActivity(session.businessId, id, body.completed);
    if (!updated) return NextResponse.json({ error: "activity_not_found" }, { status: 404 });
    return NextResponse.json({ activity: await getActivity(session.businessId, id) });
  },
);

export const DELETE = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.customersManage);
    if (error) return error;

    const { id } = await params;
    const deleted = await deleteActivity(session.businessId, id);
    if (!deleted) return NextResponse.json({ error: "activity_not_found" }, { status: 404 });
    return NextResponse.json({ result: "deleted" });
  },
);
