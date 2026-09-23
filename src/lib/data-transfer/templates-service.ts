/**
 * Mapping templates and export templates.
 *
 * "The supplier sends the same spreadsheet every month" is the whole reason
 * these exist: the mapping an operator built once — including the per-column
 * transformations and the duplicate/relationship choices — is saved, named and
 * reused, and so is a field selection plus its filters on the way out.
 *
 * Both are per-entity, deliberately. A column called «کد» means a SKU on a
 * product file and an accounting code on a person file, so a template that
 * crossed entities would confidently map the wrong thing.
 */

import { query } from "../db";
import { findEntity } from "./registry";
import type {
  ExportFormat,
  ImportMapping,
  ImportOptions,
} from "./types";

export class TemplateError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TemplateError";
  }
}

export interface MappingTemplate {
  id: string;
  entityKey: string;
  entityLabel: string;
  name: string;
  description: string;
  mapping: ImportMapping;
  options: ImportOptions;
  createdAt: string;
  updatedAt: string;
}

interface MappingRow extends Record<string, unknown> {
  id: string;
  entity_key: string;
  name: string;
  description: string;
  mapping: unknown;
  options: unknown;
  created_at: Date;
  updated_at: Date;
}

function toMappingTemplate(row: MappingRow): MappingTemplate {
  const mapping = row.mapping as { columns?: unknown } | null;
  return {
    id: row.id,
    entityKey: row.entity_key,
    entityLabel: findEntity(row.entity_key)?.label ?? row.entity_key,
    name: row.name,
    description: row.description,
    mapping: {
      columns: Array.isArray(mapping?.columns)
        ? (mapping!.columns as ImportMapping["columns"])
        : [],
    },
    options: (row.options ?? {}) as ImportOptions,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const MAPPING_COLUMNS = `id, entity_key, name, description, mapping, options, created_at, updated_at`;

export async function listMappingTemplates(
  businessId: string,
  entityKey?: string | null,
): Promise<MappingTemplate[]> {
  const params: unknown[] = [businessId];
  const where = ["business_id = $1"];
  if (entityKey) {
    params.push(entityKey);
    where.push(`entity_key = $${params.length}`);
  }
  const { rows } = await query<MappingRow>(
    `SELECT ${MAPPING_COLUMNS} FROM data_mapping_templates
      WHERE ${where.join(" AND ")} ORDER BY name`,
    params,
  );
  return rows.map(toMappingTemplate);
}

export async function getMappingTemplate(
  businessId: string,
  id: string,
): Promise<MappingTemplate | null> {
  const { rows } = await query<MappingRow>(
    `SELECT ${MAPPING_COLUMNS} FROM data_mapping_templates
      WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toMappingTemplate(rows[0]) : null;
}

export interface SaveMappingTemplateInput {
  businessId: string;
  entityKey: string;
  name: string;
  description?: string;
  mapping: ImportMapping;
  options?: ImportOptions;
  actorUserId: string | null;
}

export async function createMappingTemplate(
  input: SaveMappingTemplateInput,
): Promise<MappingTemplate> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new TemplateError("name_required");
  if (!findEntity(input.entityKey)) throw new TemplateError("unknown_entity");
  try {
    const { rows } = await query<MappingRow>(
      `INSERT INTO data_mapping_templates
         (business_id, entity_key, name, description, mapping, options, created_by)
       VALUES ($1, $2, $3, coalesce($4, ''), $5::jsonb, $6::jsonb, $7::uuid)
       RETURNING ${MAPPING_COLUMNS}`,
      [
        input.businessId,
        input.entityKey,
        name,
        input.description?.trim().slice(0, 500) ?? "",
        JSON.stringify(input.mapping),
        JSON.stringify(input.options ?? {}),
        input.actorUserId,
      ],
    );
    return toMappingTemplate(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new TemplateError("name_taken");
    throw error;
  }
}

export async function updateMappingTemplate(
  businessId: string,
  id: string,
  patch: {
    name?: string;
    description?: string;
    mapping?: ImportMapping;
    options?: ImportOptions;
  },
): Promise<MappingTemplate | null> {
  const sets = ["updated_at = now()"];
  const params: unknown[] = [businessId, id];
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 120);
    if (!name) throw new TemplateError("name_required");
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description.trim().slice(0, 500));
    sets.push(`description = $${params.length}`);
  }
  if (patch.mapping !== undefined) {
    params.push(JSON.stringify(patch.mapping));
    sets.push(`mapping = $${params.length}::jsonb`);
  }
  if (patch.options !== undefined) {
    params.push(JSON.stringify(patch.options));
    sets.push(`options = $${params.length}::jsonb`);
  }
  try {
    const { rows } = await query<MappingRow>(
      `UPDATE data_mapping_templates SET ${sets.join(", ")}
        WHERE business_id = $1 AND id = $2
        RETURNING ${MAPPING_COLUMNS}`,
      params,
    );
    return rows[0] ? toMappingTemplate(rows[0]) : null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new TemplateError("name_taken");
    throw error;
  }
}

export async function deleteMappingTemplate(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM data_mapping_templates WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Export templates
// ---------------------------------------------------------------------------

export interface ExportTemplate {
  id: string;
  entityKey: string;
  entityLabel: string;
  name: string;
  description: string;
  format: ExportFormat;
  fields: string[];
  filters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface ExportTemplateRow extends Record<string, unknown> {
  id: string;
  entity_key: string;
  name: string;
  description: string;
  format: ExportFormat;
  fields: unknown;
  filters: unknown;
  created_at: Date;
  updated_at: Date;
}

const EXPORT_TEMPLATE_COLUMNS = `id, entity_key, name, description, format, fields, filters,
  created_at, updated_at`;

function toExportTemplate(row: ExportTemplateRow): ExportTemplate {
  return {
    id: row.id,
    entityKey: row.entity_key,
    entityLabel: findEntity(row.entity_key)?.label ?? row.entity_key,
    name: row.name,
    description: row.description,
    format: row.format,
    fields: Array.isArray(row.fields) ? (row.fields as string[]) : [],
    filters: (row.filters ?? {}) as Record<string, unknown>,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listExportTemplates(
  businessId: string,
  entityKey?: string | null,
): Promise<ExportTemplate[]> {
  const params: unknown[] = [businessId];
  const where = ["business_id = $1"];
  if (entityKey) {
    params.push(entityKey);
    where.push(`entity_key = $${params.length}`);
  }
  const { rows } = await query<ExportTemplateRow>(
    `SELECT ${EXPORT_TEMPLATE_COLUMNS} FROM data_export_templates
      WHERE ${where.join(" AND ")} ORDER BY name`,
    params,
  );
  return rows.map(toExportTemplate);
}

export async function getExportTemplate(
  businessId: string,
  id: string,
): Promise<ExportTemplate | null> {
  const { rows } = await query<ExportTemplateRow>(
    `SELECT ${EXPORT_TEMPLATE_COLUMNS} FROM data_export_templates
      WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ? toExportTemplate(rows[0]) : null;
}

export interface SaveExportTemplateInput {
  businessId: string;
  entityKey: string;
  name: string;
  description?: string;
  format: ExportFormat;
  fields: readonly string[];
  filters?: Record<string, unknown>;
  actorUserId: string | null;
}

export async function createExportTemplate(
  input: SaveExportTemplateInput,
): Promise<ExportTemplate> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new TemplateError("name_required");
  if (!findEntity(input.entityKey)) throw new TemplateError("unknown_entity");
  try {
    const { rows } = await query<ExportTemplateRow>(
      `INSERT INTO data_export_templates
         (business_id, entity_key, name, description, format, fields, filters, created_by)
       VALUES ($1, $2, $3, coalesce($4, ''), $5, $6::jsonb, $7::jsonb, $8::uuid)
       RETURNING ${EXPORT_TEMPLATE_COLUMNS}`,
      [
        input.businessId,
        input.entityKey,
        name,
        input.description?.trim().slice(0, 500) ?? "",
        input.format,
        JSON.stringify([...input.fields]),
        JSON.stringify(input.filters ?? {}),
        input.actorUserId,
      ],
    );
    return toExportTemplate(rows[0]);
  } catch (error) {
    if (isUniqueViolation(error)) throw new TemplateError("name_taken");
    throw error;
  }
}

export async function updateExportTemplate(
  businessId: string,
  id: string,
  patch: {
    name?: string;
    description?: string;
    format?: ExportFormat;
    fields?: readonly string[];
    filters?: Record<string, unknown>;
  },
): Promise<ExportTemplate | null> {
  const sets = ["updated_at = now()"];
  const params: unknown[] = [businessId, id];
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 120);
    if (!name) throw new TemplateError("name_required");
    params.push(name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description.trim().slice(0, 500));
    sets.push(`description = $${params.length}`);
  }
  if (patch.format !== undefined) {
    params.push(patch.format);
    sets.push(`format = $${params.length}`);
  }
  if (patch.fields !== undefined) {
    params.push(JSON.stringify([...patch.fields]));
    sets.push(`fields = $${params.length}::jsonb`);
  }
  if (patch.filters !== undefined) {
    params.push(JSON.stringify(patch.filters));
    sets.push(`filters = $${params.length}::jsonb`);
  }
  try {
    const { rows } = await query<ExportTemplateRow>(
      `UPDATE data_export_templates SET ${sets.join(", ")}
        WHERE business_id = $1 AND id = $2
        RETURNING ${EXPORT_TEMPLATE_COLUMNS}`,
      params,
    );
    return rows[0] ? toExportTemplate(rows[0]) : null;
  } catch (error) {
    if (isUniqueViolation(error)) throw new TemplateError("name_taken");
    throw error;
  }
}

export async function deleteExportTemplate(businessId: string, id: string): Promise<boolean> {
  const { rowCount } = await query(
    `DELETE FROM data_export_templates WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return (rowCount ?? 0) > 0;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}
