import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { query } from "@/lib/db";
import { getPlatformOverview } from "@/lib/platform-overview-service";

/**
 * How many migration files on disk are not yet recorded in `schema_migrations`
 * — the single most useful "is this deployment ahead of its DB?" signal. Mirrors
 * the system route's computation (filesystem vs DB), which is why it lives here
 * rather than in the pure service.
 */
async function pendingMigrationCount(): Promise<number> {
  let onDisk: string[];
  try {
    onDisk = readdirSync(join(process.cwd(), "migrations")).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  } catch {
    return 0;
  }
  const { rows } = await query<{ filename: string }>(`SELECT filename FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.filename));
  return onDisk.filter((f) => !applied.has(f)).length;
}

/**
 * The super-admin overview dashboard aggregation (task section 3). Read-only,
 * any authenticated admin; one batched query behind `getPlatformOverview`.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const pending = await pendingMigrationCount();
  return NextResponse.json({ overview: await getPlatformOverview(pending) });
});
