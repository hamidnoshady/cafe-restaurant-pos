import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { transitionCheque } from "@/lib/cheques-service";
import { CHEQUE_ACTIONS, type ChequeAction } from "@/lib/cheques";
import { chequeErrorResponse } from "../../errors";

interface ActionBody {
  occurredOn?: string;
  endorsedToSupplierId?: string;
  memo?: string;
}

function isActionBody(value: unknown): value is ActionBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One step of a cheque's life: deposit, endorse, clear, bounce, present,
 * cancel. Which of those are legal from here is `cheques.ts`'s transition
 * table, not this route's — an illegal one comes back 409 rather than being
 * filtered out of the URL space.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string; action: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.financeChequesManage);
    if (error) return error;

    const { id, action } = await context.params;
    if (!CHEQUE_ACTIONS.includes(action as ChequeAction)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    let body: ActionBody = {};
    try {
      const parsed: unknown = await request.json();
      if (!isActionBody(parsed)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      body = parsed;
    } catch {
      // An action with no payload is ordinary — clearing a cheque needs nothing
      // but the cheque.
    }

    const location = await resolveActiveLocation(session);

    try {
      const cheque = await transitionCheque({
        businessId: session.businessId,
        locationId: location?.id ?? null,
        chequeId: id,
        action: action as ChequeAction,
        occurredOn: body.occurredOn ?? null,
        endorsedToSupplierId: body.endorsedToSupplierId ?? null,
        memo: body.memo ?? null,
        createdBy: session.sub,
      });
      return NextResponse.json({ cheque });
    } catch (err) {
      return chequeErrorResponse(err);
    }
  },
);
