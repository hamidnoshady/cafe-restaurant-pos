/** Small server-side helpers for the floor plan (DB-touching). */
import { query } from "./db";

/**
 * Validate an optional waiter id for a section assignment, scoped to this
 * location. Returns the id (assign), null (clear), or false (invalid id).
 */
export async function validWaiterId(
  locationId: string,
  waiterId: string | null | undefined,
): Promise<string | null | false> {
  if (!waiterId) return null;
  const { rows } = await query(
    `SELECT u.id FROM users u JOIN locations l ON l.business_id = u.business_id
      WHERE u.id = $1 AND l.id = $2 AND u.role = 'waiter' AND u.is_active
        AND (u.location_id IS NULL OR u.location_id = $2)`,
    [waiterId, locationId],
  );
  return rows.length > 0 ? waiterId : false;
}

/**
 * Validate an optional section id for a table, scoped to this location.
 * Returns the id (assign), null (unassign), or false (invalid).
 */
export async function resolveSectionId(
  locationId: string,
  sectionId: string | null | undefined,
): Promise<string | null | false> {
  if (!sectionId) return null;
  const { rows } = await query("SELECT id FROM floor_sections WHERE id = $1 AND location_id = $2", [
    sectionId,
    locationId,
  ]);
  return rows.length > 0 ? sectionId : false;
}
