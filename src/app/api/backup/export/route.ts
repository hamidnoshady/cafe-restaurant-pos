import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { exportTenantData, tenantDataToSql, tenantDataToXlsxBuffer } from "@/lib/tenant-export";

/**
 * Per-tenant data export (Phase 17) — every row belonging to the caller's
 * own business, in a downloadable file. Owner-only: this hands the browser
 * literally all of a business's data, a materially higher bar than "backup
 * now" (Owner/Manager) or even config (Owner-only, but scoped to settings).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const format = request.nextUrl.searchParams.get("format");
  if (format !== "sql" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }

  const tables = await exportTenantData(session.businessId);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "sql") {
    const sql = tenantDataToSql(tables);
    return new NextResponse(sql, {
      headers: {
        "Content-Type": "application/sql; charset=utf-8",
        "Content-Disposition": `attachment; filename="business-export-${stamp}.sql"`,
      },
    });
  }

  const buffer = await tenantDataToXlsxBuffer(tables);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="business-export-${stamp}.xlsx"`,
    },
  });
});
