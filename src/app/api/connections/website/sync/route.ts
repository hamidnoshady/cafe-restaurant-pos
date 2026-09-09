import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { syncWebsiteForBusiness } from "@/lib/website/sync-service";

/** «همگام‌سازی اکنون» — the same fill-then-drain the tick runs, on demand. */
export const POST = withTenantScope(async () => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const result = await syncWebsiteForBusiness(session.businessId);
  return NextResponse.json(result);
});
