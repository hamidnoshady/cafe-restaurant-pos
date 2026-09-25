import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { websiteManagersState } from "@/lib/website/managers-service";

/**
 * `GET /api/website/managers` — which of «مدیریت وب‌سایت»'s two managers this
 * business actually has.
 *
 * The app's sidebar and its home both build themselves from this: a manager
 * with no connection lists only the screens that can change that. Observed
 * state, two local reads, and no call to either external system — a down CMS
 * must not empty the app's own menu.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.websiteView);
  if (error) return error;
  const managers = await websiteManagersState(session.businessId);
  const response = NextResponse.json({ managers });
  response.headers.set("Cache-Control", "no-store");
  return response;
});
