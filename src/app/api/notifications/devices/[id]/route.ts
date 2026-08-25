import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { removeNotificationDevice } from "@/lib/notifications-service";

/** «دیگر به این دستگاه اعلان نفرست» — from the settings list, where an id is what the row has. */
export const DELETE = withTenantScope(
  async (_request, context: { params: Promise<{ id: string }> }) => {
    const guard = await requireMember();
    if (guard.error) return guard.error;

    const { id } = await context.params;
    const removed = await removeNotificationDevice(guard.session.businessId, guard.session.sub, id);
    if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ removed: true });
  },
);
