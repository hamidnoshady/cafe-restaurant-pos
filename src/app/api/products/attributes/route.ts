import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { resolveActiveLocation } from "@/lib/setup-state";
import {
  createAttributeDefinition,
  listAttributeDefinitions,
} from "@/lib/product-attributes-service";

/** The attribute master («ویژگی محصول»): every definition with its options. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.menuView);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ definitions: [] });

  const definitions = await listAttributeDefinitions(location.id);
  return NextResponse.json({ definitions });
});

/** Creates one attribute (رنگ، برند…) with its option values and status. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;
  const industryError = await requireProductWorkspaceForApi(session);
  if (industryError) return industryError;

  let body: { name?: string; options?: string[]; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const { definition, error: createError } = await createAttributeDefinition({
    locationId: location.id,
    name: body.name ?? "",
    options: body.options ?? [],
    isActive: body.isActive ?? true,
  });
  if (createError) {
    const status = createError === "duplicate_name" ? 409 : 400;
    return NextResponse.json({ error: createError }, { status });
  }
  return NextResponse.json({ ok: true, definition });
});
