import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  createExportTemplate,
  createMappingTemplate,
  listExportTemplates,
  listMappingTemplates,
} from "@/lib/data-transfer/templates-service";
import type { ExportFormat, ImportMapping, ImportOptions } from "@/lib/data-transfer/types";
import { dataOwner, entityAccess, handleDataError, PERMISSIONS, readBody } from "../guard";

/**
 * Mapping templates and export templates.
 *
 * `?kind=mapping` (default) is the saved external-column → platform-field map
 * an import reuses; `?kind=export` is a saved field selection plus filters.
 * Each is gated on the direction it belongs to — a member who may only export
 * can save an export template and not a mapping one.
 */

export const GET = withTenantScope(async (request: NextRequest) => {
  const kind = request.nextUrl.searchParams.get("kind") === "export" ? "export" : "mapping";
  const { owner, error } = await dataOwner(
    kind === "export" ? PERMISSIONS.dataExport : PERMISSIONS.dataImport,
  );
  if (error) return error;
  try {
    const entityKey = request.nextUrl.searchParams.get("entity");
    if (entityKey) {
      // A mapping template is an *import* concern (it maps a file's columns
      // onto fields); an export template is an export one.
      const { error: entityError } = await entityAccess(
        owner,
        entityKey,
        kind === "export" ? "export" : "import",
      );
      if (entityError) return entityError;
    }
    const templates =
      kind === "export"
        ? await listExportTemplates(owner.businessId, entityKey)
        : await listMappingTemplates(owner.businessId, entityKey);
    return NextResponse.json({ templates, kind });
  } catch (err) {
    return handleDataError(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const body = await readBody(request);
  const kind = body.kind === "export" ? "export" : "mapping";
  const { owner, error } = await dataOwner(
    kind === "export" ? PERMISSIONS.dataExport : PERMISSIONS.dataImport,
  );
  if (error) return error;

  try {
    const { entity, error: entityError } = await entityAccess(
      owner,
      typeof body.entity === "string" ? body.entity : null,
      kind === "export" ? "export" : "import",
    );
    if (entityError) return entityError;

    if (kind === "export") {
      const template = await createExportTemplate({
        businessId: owner.businessId,
        entityKey: entity.key,
        name: String(body.name ?? ""),
        description: typeof body.description === "string" ? body.description : "",
        format: (typeof body.format === "string" ? body.format : "xlsx") as ExportFormat,
        fields: Array.isArray(body.fields)
          ? (body.fields as unknown[]).filter((f): f is string => typeof f === "string")
          : [],
        filters:
          body.filters && typeof body.filters === "object" && !Array.isArray(body.filters)
            ? (body.filters as Record<string, unknown>)
            : {},
        actorUserId: owner.actorUserId,
      });
      return NextResponse.json({ template }, { status: 201 });
    }

    const template = await createMappingTemplate({
      businessId: owner.businessId,
      entityKey: entity.key,
      name: String(body.name ?? ""),
      description: typeof body.description === "string" ? body.description : "",
      mapping: (body.mapping as ImportMapping | undefined) ?? { columns: [] },
      options: (body.options as ImportOptions | undefined) ?? {},
      actorUserId: owner.actorUserId,
    });
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return handleDataError(err);
  }
});
