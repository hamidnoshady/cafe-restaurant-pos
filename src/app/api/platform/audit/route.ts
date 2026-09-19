import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { queryAudit, type AuditQuery } from "@/lib/platform-service";

/**
 * The platform audit log — every privileged cross-tenant action, newest first.
 * Filtered, searched and paginated server-side (task section 12): params are
 * `businessId`, `adminId`, `actionFamily`, `entity`, `search`, `from`/`to`
 * (ISO dates), `page`, `pageSize`. Read-only; any admin sees it, because the
 * console's whole accountability story is that these are visible. The response
 * carries `meta` with pagination info (task section 25).
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const sp = request.nextUrl.searchParams;
  const pageNum = Number(sp.get("page"));
  const pageSizeNum = Number(sp.get("pageSize"));

  const q: AuditQuery = {
    businessId: sp.get("businessId") ?? undefined,
    adminId: sp.get("adminId") ?? undefined,
    actionFamily: sp.get("actionFamily") ?? undefined,
    entity: sp.get("entity") ?? undefined,
    search: sp.get("search") ?? undefined,
    createdFrom: sp.get("from") ?? undefined,
    createdTo: sp.get("to") ?? undefined,
    page: Number.isFinite(pageNum) && pageNum > 0 ? pageNum : undefined,
    pageSize: Number.isFinite(pageSizeNum) && pageSizeNum > 0 ? pageSizeNum : undefined,
  };

  const result = await queryAudit(q);
  return NextResponse.json({
    entries: result.entries,
    meta: { total: result.total, page: result.page, pageSize: result.pageSize },
  });
});
