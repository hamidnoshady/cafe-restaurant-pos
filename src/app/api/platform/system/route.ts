import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { query } from "@/lib/db";
import { systemStatus } from "@/lib/platform-service";

/**
 * How many migration files on disk have not yet been recorded in
 * `schema_migrations`. A non-zero count means the running code is ahead of the
 * database — the single most useful "is this deployment healthy?" signal, and
 * exactly what the migration runner would apply on its next run. Computed here
 * (rather than in the service) because it compares the filesystem to the DB.
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
 * Platform health for the system page: applied migrations and how many are
 * pending, the live connection-pool figures, whether RLS is actually being
 * enforced (the app must not connect as a superuser or bypass role), the most
 * recent backup per business, and headline counts. Read-only — a dashboard,
 * not a control surface.
 */
export async function GET() {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const pending = await pendingMigrationCount();
  return NextResponse.json({ status: await systemStatus(pending) });
}
