import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { exportCustomersCsv } from "@/lib/crm-export-service";

/**
 * Download the customer directory as CSV.
 *
 * Behind `crm.export`, not `crm.view`. Reading one customer's file and walking
 * out with the whole list are different acts: the second is the one that ends
 * up on a competitor's laptop, and it is the one a departing employee performs
 * on their last day. The service audits every call with the row count and the
 * filters used.
 *
 * Streaming is deliberately not used. The row ceiling is 50,000 and the
 * service builds the document in memory, which keeps the audit write and the
 * response atomic — a half-streamed export that failed mid-flight would be
 * recorded as a completed one.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmExport);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const limitRaw = Number(search.get("limit"));

  const { csv, rowCount } = await exportCustomersCsv(
    session.businessId,
    {
      segmentId: search.get("segmentId"),
      tag: search.get("tag"),
      lifecycle: search.get("lifecycle"),
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    },
    { name: session.fullName, userId: session.sub },
  );

  // A date-stamped ASCII filename. Persian in a Content-Disposition header
  // needs RFC 5987 encoding that not every browser handles the same way, and a
  // mangled filename on a downloaded file is worse than a plain one.
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="customers-${stamp}.csv"`,
      "X-Row-Count": String(rowCount),
      // Never cached: the response is the customer list, and a shared cache
      // holding it is a data leak.
      "Cache-Control": "no-store",
    },
  });
});
