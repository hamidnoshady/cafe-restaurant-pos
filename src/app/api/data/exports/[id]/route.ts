import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { getExportContent, getExportJob } from "@/lib/data-transfer/export-service";
import {
  dataOwner,
  entityAccess,
  fileResponse,
  handleDataError,
  PERMISSIONS,
} from "../../guard";

/**
 * Download a previously produced export again.
 *
 * The bytes are kept on the job row for a retention window (see
 * `EXPORT_RETENTION_DAYS`); once pruned, the history row survives — who
 * exported what, when, how many rows — and this answers 410 rather than
 * pretending the file is still there.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
    if (error) return error;
    try {
      const { id } = await params;
      const job = await getExportJob(owner.businessId, id);
      if (!job) return NextResponse.json({ error: "job_not_found" }, { status: 404 });
      // Re-checked on every download, not only when the file was produced: a
      // member whose CRM export permission was revoked last week must not keep
      // a working link to the customer directory.
      const { error: entityError } = await entityAccess(owner, job.entityKey, "export");
      if (entityError) return entityError;

      const content = await getExportContent(owner.businessId, id);
      if (!content) return NextResponse.json({ error: "content_expired" }, { status: 410 });
      return fileResponse(content.body, content.contentType, content.fileName);
    } catch (err) {
      return handleDataError(err);
    }
  },
);
