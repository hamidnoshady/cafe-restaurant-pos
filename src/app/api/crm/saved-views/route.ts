import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  deleteSavedView,
  isSavedViewEntity,
  listSavedViews,
  saveView,
} from "@/lib/crm-saved-views-service";
import { isUuid } from "@/lib/uuid";

/**
 * Saved list views — «نماهای ذخیره‌شده».
 *
 * All three verbs need only `crm.view`: a saved view is a bookmark over data
 * the caller can already see, and the service scopes both reads and writes to
 * the caller's own views plus the business's shared ones.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const entity = request.nextUrl.searchParams.get("entity");
  if (!isSavedViewEntity(entity)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  return NextResponse.json({
    views: await listSavedViews(session.businessId, entity, session.sub),
  });
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (!isSavedViewEntity(body.entity)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await saveView(
    session.businessId,
    {
      id: typeof body.id === "string" && isUuid(body.id) ? body.id : undefined,
      entity: body.entity,
      name: String(body.name ?? ""),
      filters: body.filters,
      shared: body.shared === true,
    },
    { name: session.fullName, userId: session.sub },
  );

  if (!result.ok) {
    const status =
      result.error === "not_found" ? 404 : result.error === "forbidden" ? 403 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ view: result.view });
});

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!isUuid(id)) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const removed = await deleteSavedView(session.businessId, id, { userId: session.sub });
  if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
});
