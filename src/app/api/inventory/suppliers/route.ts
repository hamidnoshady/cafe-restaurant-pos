import { NextRequest, NextResponse } from "next/server";
import { requirePermission, requireRole, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { PartyValidationError, createParty } from "@/lib/parties-service";
import { query } from "@/lib/db";
import { resolveActiveLocation } from "@/lib/setup-state";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  let body: { name?: string; phone?: string; notes?: string; partyId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  /*
   * Two ways to become this branch's supplier, and both end with the same row shape:
   * a `partyId` links a counterparty the CRM or Accounting already keeps, and a
   * `name` creates the party first and links it in the same request. What is
   * deliberately not here is a third way — a branch-local row with no party —
   * because that is how "the supplier the store sees" and "the supplier the ledger
   * pays" became different people. The alias keeps a copy of the name and phone for
   * the branches that have not been linked yet, and writes one here only so that
   * legacy display path stays filled.
   */
  const notes = body.notes?.trim() || null;
  let partyId: string;
  let partyName: string;
  let partyPhone: string | null;

  if (body.partyId) {
    const { rows } = await query<{ id: string; name: string; phone: string | null }>(
      `SELECT id, name, phone FROM parties WHERE business_id = $1 AND id = $2 AND role = 'Supplier'`,
      [session.businessId, body.partyId],
    );
    if (!rows[0]) return NextResponse.json({ error: "party_not_found" }, { status: 404 });
    partyId = rows[0].id;
    partyName = rows[0].name;
    partyPhone = rows[0].phone;
  } else {
    const name = body.name?.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const gate = await requirePermission(PERMISSIONS.partiesManage);
    if (gate.error) return gate.error;
    try {
      const party = await createParty(session.businessId, {
        role: "Supplier",
        displayName: name,
        phone: body.phone?.trim() || null,
      });
      partyId = party.id;
      partyName = name;
      partyPhone = party.phone ?? null;
    } catch (err) {
      if (err instanceof PartyValidationError) {
        return NextResponse.json({ error: err.code }, { status: 409 });
      }
      throw err;
    }
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO suppliers (location_id, name, phone, notes, party_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [location.id, partyName, partyPhone, notes, partyId],
  );
  return NextResponse.json({ ok: true, id: rows[0].id, partyId });
});
