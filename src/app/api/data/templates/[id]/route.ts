import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  deleteExportTemplate,
  deleteMappingTemplate,
  getExportTemplate,
  getMappingTemplate,
  updateExportTemplate,
  updateMappingTemplate,
} from "@/lib/data-transfer/templates-service";
import type { ExportFormat, ImportMapping, ImportOptions } from "@/lib/data-transfer/types";
import { dataOwner, entityAccess, handleDataError, PERMISSIONS, readBody } from "../../guard";

/** Edit (PATCH) or delete (DELETE) one saved template of either kind. */

function kindOf(request: NextRequest, body?: Record<string, unknown>): "mapping" | "export" {
  if (body && body.kind === "export") return "export";
  return request.nextUrl.searchParams.get("kind") === "export" ? "export" : "mapping";
}

export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const body = await readBody(request);
    const kind = kindOf(request, body);
    const { owner, error } = await dataOwner(
      kind === "export" ? PERMISSIONS.dataExport : PERMISSIONS.dataImport,
    );
    if (error) return error;

    try {
      const { id } = await params;
      const existing =
        kind === "export"
          ? await getExportTemplate(owner.businessId, id)
          : await getMappingTemplate(owner.businessId, id);
      if (!existing) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(
        owner,
        existing.entityKey,
        kind === "export" ? "export" : "import",
      );
      if (entityError) return entityError;

      if (kind === "export") {
        const template = await updateExportTemplate(owner.businessId, id, {
          name: typeof body.name === "string" ? body.name : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
          format: typeof body.format === "string" ? (body.format as ExportFormat) : undefined,
          fields: Array.isArray(body.fields)
            ? (body.fields as unknown[]).filter((f): f is string => typeof f === "string")
            : undefined,
          filters:
            body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
              ? (body.filters as Record<string, unknown>)
              : undefined,
        });
        return NextResponse.json({ template });
      }

      const template = await updateMappingTemplate(owner.businessId, id, {
        name: typeof body.name === "string" ? body.name : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        mapping: (body.mapping as ImportMapping | undefined) ?? undefined,
        options: (body.options as ImportOptions | undefined) ?? undefined,
      });
      return NextResponse.json({ template });
    } catch (err) {
      return handleDataError(err);
    }
  },
);

export const DELETE = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const kind = kindOf(request);
    const { owner, error } = await dataOwner(
      kind === "export" ? PERMISSIONS.dataExport : PERMISSIONS.dataImport,
    );
    if (error) return error;

    try {
      const { id } = await params;
      const existing =
        kind === "export"
          ? await getExportTemplate(owner.businessId, id)
          : await getMappingTemplate(owner.businessId, id);
      if (!existing) return NextResponse.json({ error: "template_not_found" }, { status: 404 });
      const { error: entityError } = await entityAccess(
        owner,
        existing.entityKey,
        kind === "export" ? "export" : "import",
      );
      if (entityError) return entityError;

      const removed =
        kind === "export"
          ? await deleteExportTemplate(owner.businessId, id)
          : await deleteMappingTemplate(owner.businessId, id);
      return NextResponse.json({ ok: removed });
    } catch (err) {
      return handleDataError(err);
    }
  },
);
