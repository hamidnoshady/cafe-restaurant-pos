import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { query } from "@/lib/db";

/** Active chart of accounts, for populating manual-entry account pickers. */
export async function GET() {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const { rows } = await query(
    `SELECT a.id, a.code, a.name, a.type, p.code AS parent_code
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.business_id = $1 AND a.is_active ORDER BY a.code`,
    [session.businessId],
  );
  return NextResponse.json({ accounts: rows });
}
