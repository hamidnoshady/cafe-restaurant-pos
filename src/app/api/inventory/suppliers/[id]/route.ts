import { NextRequest, NextResponse } from "next/server";
import { type SessionPayload, withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

async function ownedSupplier(session: SessionPayload, id: string) {
  const location = await resolveActiveLocation(session);
  if (!location) return null;
  const { rows } = await query<{ id: string }>("SELECT id FROM suppliers WHERE id = $1 AND location_id = $2", [
    id,
    location.id,
  ]);
  return rows[0] ? location : null;
}

export const PATCH = withTenantScope(async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedSupplier(session, id);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let body: { name?: string; phone?: string | null; notes?: string | null; isActive?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const set = (col: string, val: unknown) => {
    fields.push(`${col} = $${++i}`);
    values.push(val);
  };

  /*
   * What a branch may say about a supplier: its own note, and whether this branch
   * buys from them at all. The name and the phone are the party's — a linked row
   * refuses the edit rather than letting the alias drift away from the record the
   * ledger pays. (`/api/parties` is where they change, and the store's own tab
   * mounts the shared directory for exactly that.)
   */
  const linked = await query<{ party_id: string | null }>(
    "SELECT party_id FROM suppliers WHERE id = $1",
    [id],
  );
  if (linked.rows[0]?.party_id && (body.name !== undefined || body.phone !== undefined)) {
    return NextResponse.json({ error: "supplier_identity_on_party" }, { status: 409 });
  }
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    set("name", name);
  }
  if (body.phone !== undefined) set("phone", body.phone?.trim() || null);
  if (body.notes !== undefined) set("notes", body.notes?.trim() || null);
  if (body.isActive !== undefined) set("is_active", Boolean(body.isActive));
  if (fields.length === 0) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  await query(`UPDATE suppliers SET ${fields.join(", ")} WHERE id = $1`, [id, ...values]);
  return NextResponse.json({ ok: true });
});

export const DELETE = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.purchasesManage);
  if (error) return error;
  const { id } = await context.params;

  const location = await ownedSupplier(session, id);
  if (!location) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows: refs } = await query("SELECT 1 FROM purchases WHERE supplier_id = $1 LIMIT 1", [id]);
  if (refs.length > 0) {
    await query("UPDATE suppliers SET is_active = false WHERE id = $1", [id]);
    return NextResponse.json({ ok: true, deactivated: true });
  }
  await query("DELETE FROM suppliers WHERE id = $1", [id]);
  return NextResponse.json({ ok: true, deactivated: false });
});
