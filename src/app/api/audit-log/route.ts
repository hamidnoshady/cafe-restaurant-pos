import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { listAuditLog } from "@/lib/audit-service";
import { PERMISSIONS } from "@/lib/permissions";

const MAX_LIMIT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_FILTER = /^[a-z][a-z0-9_.-]{0,79}$/i;

/** Business-wide, read-only audit trail. Invalid cursors and filters are rejected
 * instead of silently producing surprising pages (or reaching PostgreSQL casts). */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.teamManage);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const beforeRaw = params.get("before");
  const limitRaw = params.get("limit");
  const entity = params.get("entity");
  const action = params.get("action");
  const actorId = params.get("actorId");
  const entityId = params.get("entityId");

  if (beforeRaw && (!/^\d+$/.test(beforeRaw) || !Number.isSafeInteger(Number(beforeRaw)) || Number(beforeRaw) < 1)) {
    return NextResponse.json({ error: "invalid_before" }, { status: 400 });
  }
  if (limitRaw && (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > MAX_LIMIT)) {
    return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
  }
  if ((entity && !SAFE_FILTER.test(entity)) || (action && !SAFE_FILTER.test(action))) {
    return NextResponse.json({ error: "invalid_filter" }, { status: 400 });
  }
  if ((actorId && !UUID.test(actorId)) || (entityId && entity === "account" && !UUID.test(entityId))) {
    return NextResponse.json({ error: "invalid_identifier" }, { status: 400 });
  }

  const entries = await listAuditLog(session.businessId, {
    entity: entity || undefined,
    entityId: entityId || undefined,
    actorId: actorId || undefined,
    action: action || undefined,
    before: beforeRaw ? Number(beforeRaw) : undefined,
    limit: limitRaw ? Number(limitRaw) : undefined,
  });
  return NextResponse.json({ entries });
});
