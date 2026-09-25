import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getChequeHistory } from "@/lib/cheques-service";
import { chequeErrorResponse } from "../../errors";

/**
 * History of one cheque — the append-only event log that makes
 * "why is this cheque in 1244" answerable without reading the ledger backwards.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
    if (error) return error;
    const { id } = await context.params;
    try {
      const events = await getChequeHistory(session.businessId, id);
      return NextResponse.json({ events });
    } catch (err) {
      return chequeErrorResponse(err);
    }
  },
);
