import { NextRequest, NextResponse } from "next/server";
import {withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listConsentEvents, setConsent } from "@/lib/crm-service";
import { CONSENT_CHANNELS, CONSENT_SOURCES, type ConsentChannel, type ConsentSource } from "@/lib/crm-shared";

/**
 * One customer's consent — the current flags' history, and the way to change
 * them (Phase 36).
 *
 * Owner/manager only, and deliberately stricter than the rest of the customer
 * file. Consent is the permission a business relies on when it defends a
 * message it sent; a flag flipped during a busy shift, with no reason recorded,
 * is exactly the situation the audit trail exists to prevent. The service
 * writes the flag and its event in one transaction, so there is no path that
 * changes the flag without saying who changed it and why.
 *
 * There is also no path here — or anywhere — for the assistant to touch these
 * flags. `crm.customer.tag` and `crm.customer.note` are the only CRM actions in
 * the catalogue.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const { id } = await params;
    const events = await listConsentEvents(session.businessId, { customerId: id });
    return NextResponse.json({ events });
  },
);

interface ConsentBody {
  channel?: string;
  granted?: boolean;
  source?: string;
  note?: string;
}

export const POST = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmConsentManage);
    if (error) return error;

    let body: ConsentBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (!CONSENT_CHANNELS.includes(body.channel as ConsentChannel)) {
      return NextResponse.json({ error: "consent_channel_invalid" }, { status: 400 });
    }
    if (typeof body.granted !== "boolean") {
      return NextResponse.json({ error: "consent_state_required" }, { status: 400 });
    }
    // An unrecognised source is rejected rather than coerced to `staff`: the
    // source is the difference between "the customer asked us to stop" and
    // "someone in the back office ticked a box", which is the whole value of
    // the record.
    const source = (body.source ?? "staff") as ConsentSource;
    if (!CONSENT_SOURCES.includes(source)) {
      return NextResponse.json({ error: "consent_source_invalid" }, { status: 400 });
    }

    const { id } = await params;
    const result = await setConsent(session.businessId, id, {
      channel: body.channel as ConsentChannel,
      granted: body.granted,
      source,
      note: body.note,
      changedBy: session.fullName,
    });
    if (!result) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
    return NextResponse.json({ consent: result });
  },
);
