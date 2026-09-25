import { NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";

/**
 * The `source_type` values this business's journal actually contains.
 *
 * The journal's «منبع سند» filter is built from this rather than from the full
 * label table: a café has never posted a `gold_sale`, and offering fifty codes
 * of which six can match is a worse filter than six that all can. Codes come
 * back raw; the screen labels them through `ledgerSourceLabel`, which is the
 * one place a code becomes Persian.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const { rows } = await query<{ source_type: string | null }>(
    `SELECT DISTINCT source_type
       FROM journal_entries
      WHERE business_id = $1 AND source_type IS NOT NULL
      ORDER BY source_type`,
    [session.businessId],
  );
  return NextResponse.json({ sourceTypes: rows.map((r) => r.source_type).filter((s): s is string => !!s) });
});
