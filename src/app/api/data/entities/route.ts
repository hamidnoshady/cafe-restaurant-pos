import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { DATA_ENTITIES, defaultExportFields, isImportable } from "@/lib/data-transfer/registry";
import { DATA_MODULE_LABELS } from "@/lib/data-transfer/types";
import { dataOwner, handleDataError, PERMISSIONS } from "../guard";

/**
 * The catalogue the «ورود و خروج داده» screen is built from.
 *
 * One read: every entity this member may actually move, with its fields, its
 * duplicate rules and which directions are open to them. The screen renders
 * only what comes back, so a member without `menu.edit` never sees an import
 * button that would answer 403 — the list and the routes are computed from the
 * same permission set.
 *
 * Gated on `data.export` rather than `data.import`: reading the catalogue is
 * the weaker of the two, and every member who may do anything here holds it.
 */
export const GET = withTenantScope(async () => {
  const { owner, error } = await dataOwner(PERMISSIONS.dataExport);
  if (error) return error;

  try {
    const access = await memberAccessFor(owner.session);
    const granted = access?.permissions ?? new Set<string>();
    const mayImport = granted.has(PERMISSIONS.dataImport);

    const entities = DATA_ENTITIES.filter((entity) => granted.has(entity.exportPermission)).map(
      (entity) => ({
        key: entity.key,
        module: entity.module,
        moduleLabel: DATA_MODULE_LABELS[entity.module],
        label: entity.label,
        description: entity.description,
        locationScoped: entity.locationScoped === true,
        canExport: true,
        canImport:
          mayImport &&
          isImportable(entity) &&
          Boolean(entity.importPermission && granted.has(entity.importPermission)),
        defaultExportFields: defaultExportFields(entity),
        duplicateRules: entity.duplicateRules ?? [],
        fields: entity.fields.map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type,
          required: field.required === true,
          readOnly: field.readOnly === true,
          exportDefault: field.exportDefault === true,
          hint: field.hint ?? null,
          options: field.options ?? null,
          relation: field.relation
            ? { entity: field.relation.entity, label: field.relation.label, onMissing: field.relation.onMissing }
            : null,
        })),
      }),
    );

    return NextResponse.json({ entities, canImport: mayImport });
  } catch (err) {
    return handleDataError(err);
  }
});
