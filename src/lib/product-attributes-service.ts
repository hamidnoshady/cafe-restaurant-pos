/**
 * Phase 42 — the attribute master («ویژگی محصول») behind the products
 * workspace.
 *
 * `item_variant_attributes` (0050) stores the name/value pairs a variant
 * child carries, but nothing owned the *vocabulary*: «رنگ» and the values it
 * may take were free-typed on every add. This service is that vocabulary —
 * one row per attribute per location, with its option list and an active
 * flag, exactly the card the workspace's «ویژگی محصول» screen edits. Variant
 * rows keep their own copy (a variant sold as «رنگ: عسلی» must stay that way
 * even if the definition later renames), the same way suppliers keep alias
 * copies of a shared party (0137).
 */
import { query } from "./db";

export interface AttributeDefinition {
  id: string;
  locationId: string;
  name: string;
  options: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface DefinitionRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  name: string;
  options: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function mapDefinition(row: DefinitionRow): AttributeDefinition {
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    options: row.options ?? [],
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAttributeDefinitions(locationId: string): Promise<AttributeDefinition[]> {
  const { rows } = await query<DefinitionRow>(
    `SELECT * FROM item_attribute_definitions
      WHERE location_id = $1
      ORDER BY is_active DESC, created_at`,
    [locationId],
  );
  return rows.map(mapDefinition);
}

export async function getAttributeDefinition(id: string): Promise<AttributeDefinition | null> {
  const { rows } = await query<DefinitionRow>(
    `SELECT * FROM item_attribute_definitions WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapDefinition(rows[0]) : null;
}

export async function createAttributeDefinition(input: {
  locationId: string;
  name: string;
  options: string[];
  isActive: boolean;
}): Promise<{ definition?: AttributeDefinition; error?: string }> {
  const name = input.name.trim();
  if (!name) return { error: "missing_fields" };
  const options = dedupe(input.options.map((o) => o.trim()).filter(Boolean));
  try {
    const { rows } = await query<DefinitionRow>(
      `INSERT INTO item_attribute_definitions (location_id, name, options, is_active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.locationId, name, options, input.isActive],
    );
    return { definition: mapDefinition(rows[0]) };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

export async function updateAttributeDefinition(
  id: string,
  patch: { name?: string; options?: string[]; isActive?: boolean },
): Promise<{ definition?: AttributeDefinition; error?: string }> {
  const current = await getAttributeDefinition(id);
  if (!current) return { error: "not_found" };
  const name = (patch.name ?? current.name).trim();
  if (!name) return { error: "missing_fields" };
  const options = dedupe((patch.options ?? current.options).map((o) => o.trim()).filter(Boolean));
  const isActive = patch.isActive ?? current.isActive;
  try {
    const { rows } = await query<DefinitionRow>(
      `UPDATE item_attribute_definitions
          SET name = $2, options = $3, is_active = $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, name, options, isActive],
    );
    return { definition: mapDefinition(rows[0]) };
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

export async function deleteAttributeDefinition(id: string): Promise<boolean> {
  const { rowCount } = await query(`DELETE FROM item_attribute_definitions WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
