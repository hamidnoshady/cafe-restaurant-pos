import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { updateWebsiteSyncSettings } from "@/lib/website/connection-service";

/**
 * The Wave 3 switches: push prices, push stock (independent), product scope
 * and which branch the site mirrors.
 */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { pushPrices?: unknown; pushStock?: unknown; productScope?: unknown; syncLocationId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const connection = await updateWebsiteSyncSettings(session.businessId, {
    pushPrices: typeof body.pushPrices === "boolean" ? body.pushPrices : undefined,
    pushStock: typeof body.pushStock === "boolean" ? body.pushStock : undefined,
    productScope: body.productScope === "all" || body.productScope === "selected" ? body.productScope : undefined,
    syncLocationId:
      body.syncLocationId === null ? null : typeof body.syncLocationId === "string" ? body.syncLocationId : undefined,
  });
  if (!connection) return NextResponse.json({ error: "not_connected" }, { status: 409 });
  return NextResponse.json({ connection });
});
