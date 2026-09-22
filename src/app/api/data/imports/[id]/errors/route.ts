import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { failedRowsCsv, getImportJob } from "@/lib/data-transfer/import-service";
import {
  dataOwner,
  entityAccess,
  fileResponse,
  handleDataError,
  PERMISSIONS,
} from "../../../guard";

/**
 * The failed-row report: the rows a run could not write, as a CSV.
 *
 * Their ORIGINAL cells plus a reason column — not our re-rendering of the
 * mapped values. A report that shows what we understood rather than what they
 * sent is one the operator cannot act on, and the point of this file is that
 * they fix it in place and upload it again.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataImport);
    if (error) return error;
    try {
      const { id } = await params;
      const job = await getImportJob(owner.businessId, id);
      if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(owner, job.entityKey, "import");
      if (entityError) return entityError;

      const csv = await failedRowsCsv(owner.businessId, id);
      return fileResponse(csv, "text/csv; charset=utf-8", `سطرهای-ردشده-${job.fileName}.csv`);
    } catch (err) {
      return handleDataError(err);
    }
  },
);
