import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/uuid";

type Context = { params: Promise<{ id: string }> };

/**
 * Phase 42 — one warehouse document with its lines, for the detail panel of
 * the «رسید و حواله‌های انبار» list.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: Context) => {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;
  const { id } = await context.params;
  // A non-uuid id would raise `invalid input syntax for type uuid` (a 500)
  // instead of "no rows" — it is simply a document that cannot exist.
  if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows: docs } = await query<{
    id: string;
    kind: string;
    location_name: string;
    supplier_name: string | null;
    recipient: string | null;
    document_number: string | null;
    note: string | null;
    total_value_rial: string;
    created_at: string;
    created_by_name: string | null;
  }>(
    `SELECT d.id, d.kind, l.name AS location_name,
            COALESCE(p.name, s.name) AS supplier_name,
            d.recipient, d.document_number, d.note,
            d.total_value_rial::text AS total_value_rial,
            d.created_at, u.full_name AS created_by_name
       FROM warehouse_documents d
       JOIN locations l ON l.id = d.location_id
       LEFT JOIN suppliers s ON s.id = d.supplier_id
       LEFT JOIN parties p ON p.id = s.party_id AND p.business_id = $1
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.id = $2 AND d.business_id = $1`,
    [session.businessId, id],
  );
  const doc = docs[0];
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { rows: lines } = await query<{
    id: string;
    item_name: string;
    unit: string;
    quantity: string;
    unit_cost: string;
    value_rial: string;
    note: string | null;
  }>(
    `SELECT l2.id, ii.name AS item_name, ii.unit,
            l2.quantity::text AS quantity, l2.unit_cost::text AS unit_cost,
            l2.value_rial::text AS value_rial, l2.note
       FROM warehouse_document_lines l2
       JOIN warehouse_documents d ON d.id = l2.document_id
       JOIN inventory_items ii ON ii.id = l2.inventory_item_id
      WHERE d.id = $1 AND d.business_id = $2
      ORDER BY ii.name`,
    [id, session.businessId],
  );

  return NextResponse.json({ document: doc, lines });
});
