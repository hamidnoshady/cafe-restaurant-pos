import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { AccountsError, deleteAccount, updateAccount } from "@/lib/accounts-service";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * Renames, reparents, and/or archives-or-restores an account — whichever
 * fields are present, all of them in one transaction.
 *
 * It used to call three services in sequence, which meant a PATCH carrying a
 * rename *and* a move that the hierarchy rules reject (`parent_too_deep`,
 * `parent_cycle`) applied the rename anyway and then returned the error: the
 * caller saw a failure, and the account had still changed. `updateAccount`
 * applies the whole patch or none of it.
 *
 * `parentId` is an instruction only when the key is actually present, since
 * moving an account to the top level is `parentId: null` and must stay
 * distinguishable from "don't touch the parent".
 */
export const PATCH = withTenantScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  const { id } = await ctx.params;
  let body: { name?: unknown; parentId?: unknown; isActive?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const hasName = "name" in body;
  const hasParent = "parentId" in body;
  const hasActive = "isActive" in body;
  if (hasName && typeof body.name !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (hasParent && body.parentId !== null && typeof body.parentId !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (hasActive && typeof body.isActive !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!hasName && !hasParent && !hasActive) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  try {
    await updateAccount({
      businessId: session.businessId,
      id,
      actorId: session.sub,
      name: hasName ? (body.name as string) : undefined,
      parentId: hasParent ? ((body.parentId as string | null) || null) : undefined,
      reparent: hasParent,
      isActive: hasActive ? (body.isActive as boolean) : undefined,
    });
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
