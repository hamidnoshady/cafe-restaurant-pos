import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { AccountsError, deleteAccount, renameAccount, reparentAccount, setAccountActive } from "@/lib/accounts-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Renames, reparents, and/or archives-or-restores an account — whichever
 * fields are present. Separate calls compose fine (the UI makes one call per
 * action), but a single PATCH also covers "rename while reparenting" in one
 * round trip.
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { name?: string; parentId?: string | null; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    if (typeof body.name === "string") await renameAccount(session.businessId, id, body.name, session.sub);
    if ("parentId" in body) await reparentAccount(session.businessId, id, body.parentId ?? null, session.sub);
    if (typeof body.isActive === "boolean") await setAccountActive(session.businessId, id, body.isActive, session.sub);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AccountsError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});

/** Hard delete — only ever succeeds for an account nothing has posted to yet. */
export const DELETE = withTenantScope(async (_request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  const { id } = await ctx.params;
  try {
    await deleteAccount(session.businessId, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AccountsError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
});
