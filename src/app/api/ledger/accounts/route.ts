import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireRole, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { createAccount, listAccounts, AccountsError } from "@/lib/accounts-service";

/**
 * GET without ?all returns the active chart, for populating account pickers
 * (manual entries, …) — unchanged from before this phase. ?all=1 returns
 * every account, active or archived, with the postings/children flags the
 * management UI needs to decide what's safe to archive or delete.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "accountant");
  if (error) return error;

  const all = new URL(request.url).searchParams.get("all");
  if (all) {
    const accounts = await listAccounts(session.businessId);
    return NextResponse.json({ accounts });
  }

  const { rows } = await query(
    `SELECT a.id, a.code, a.name, a.type, p.code AS parent_code
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.business_id = $1 AND a.is_active ORDER BY a.code`,
    [session.businessId],
  );
  return NextResponse.json({ accounts: rows });
});

/** Adds an account (optionally a sub-account) to the chart. Gated on accounts.edit. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  let body: { code?: string; name?: string; type?: string; parentId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    const result = await createAccount({
      businessId: session.businessId,
      code: String(body.code ?? ""),
      name: String(body.name ?? ""),
      type: String(body.type ?? ""),
      parentId: body.parentId ?? null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof AccountsError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
