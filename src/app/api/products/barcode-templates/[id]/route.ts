import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { requireProductWorkspaceForApi } from "@/lib/industry-guard";
import { deleteWeightBarcodeTemplate } from "@/lib/weight-barcode-templates-service";

export const DELETE = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
    if (error) return error;
    const industryError = await requireProductWorkspaceForApi(session);
    if (industryError) return industryError;

    const { id } = await context.params;
    const deleted = await deleteWeightBarcodeTemplate(id);
    if (!deleted) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
