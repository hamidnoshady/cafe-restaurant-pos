import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { exportTenantData, tenantDataToSql, tenantDataToXlsxBuffer } from "@/lib/tenant-export";
import { getBackupConfig } from "@/lib/backup-service";
import { backupPassphrase, encryptBackup } from "@/lib/backup";

/**
 * Per-tenant data export (Phase 17) — every row belonging to the caller's
 * own business, in a downloadable file. Owner-only: this hands the browser
 * literally all of a business's data, a materially higher bar than "backup
 * now" (Owner/Manager) or even config (Owner-only, but scoped to settings).
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.backupExport);
  if (error) return error;

  const format = request.nextUrl.searchParams.get("format");
  if (format !== "sql" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }

  const encrypt = request.nextUrl.searchParams.get("encrypt") === "1";
  let pp = "";
  if (encrypt) {
    const config = await getBackupConfig(session.businessId);
    pp = backupPassphrase(config);
    if (!pp) {
      return NextResponse.json({ error: "passphrase_required" }, { status: 409 });
    }
  }

  const tables = await exportTenantData(session.businessId);
  const stamp = new Date().toISOString().slice(0, 10);

  const defaultHeaders = {
    "Cache-Control": "no-store",
  };

  if (format === "sql") {
    let payload: string | Uint8Array = tenantDataToSql(tables);
    let filename = `business-export-${stamp}.sql`;
    let contentType = "application/sql; charset=utf-8";

    if (encrypt) {
      payload = new Uint8Array(encryptBackup(Buffer.from(payload, "utf8"), pp));
      filename += ".enc";
      contentType = "application/octet-stream";
    }

    const body = typeof payload === "string" ? payload : new Blob([Uint8Array.from(payload)]);
    return new NextResponse(body, {
      headers: {
        ...defaultHeaders,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  let payload: Uint8Array = new Uint8Array(await tenantDataToXlsxBuffer(tables));
  let filename = `business-export-${stamp}.xlsx`;
  let contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  if (encrypt) {
    payload = new Uint8Array(encryptBackup(Buffer.from(payload), pp));
    filename += ".enc";
    contentType = "application/octet-stream";
  }

  return new NextResponse(new Uint8Array(payload), {
    headers: {
      ...defaultHeaders,
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
});
