import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { convertLead, findLeadDuplicates, getLead } from "@/lib/crm-lead-service";
import { PERMISSIONS } from "@/lib/permissions";
import { tomanToRial } from "@/lib/money";
import { isUuid } from "@/lib/uuid";

/**
 * Turn a lead into a customer.
 *
 * ## The duplicate handshake
 *
 * This endpoint can refuse. `GET` reports what conversion would collide with,
 * so the UI can show the matches *before* the user commits; `POST` re-checks
 * inside the transaction, because the two calls are seconds apart and someone
 * else may have created the customer in between.
 *
 * Two or more matches **stop** the conversion outright — no
 * `acknowledgeDuplicates`, no override. With one match there is a sensible
 * question ("is this them?"); with two there is no honest way for the server
 * to choose, and picking the oldest is precisely the bug that attached one
 * customer's orders to another's file. The user resolves it by choosing a
 * `partyId` explicitly.
 *
 * Nothing here posts money. An optional deal may be opened, and a deal is a
 * forecast.
 */

export const GET = withTenantScope(
  async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmView);
    if (error) return error;

    const { id } = await context.params;
    if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const lead = await getLead(session.businessId, id);
    if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const duplicates = await findLeadDuplicates(session.businessId, {
      phone: typeof lead.phone === "string" ? lead.phone : null,
      email: typeof lead.email === "string" ? lead.email : null,
    });
    return NextResponse.json({ duplicates });
  },
);

interface ConvertBody {
  partyId?: string;
  createDeal?: boolean;
  dealTitle?: string;
  dealValueToman?: number;
  dealValueRial?: number;
  dealExpectedCloseDate?: string | null;
  acknowledgeDuplicates?: boolean;
}

export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.crmManage);
    if (error) return error;

    const { id } = await context.params;
    if (!isUuid(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });

    let body: ConvertBody;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    if (body.partyId !== undefined && !isUuid(body.partyId)) {
      return NextResponse.json({ error: "party_not_found" }, { status: 400 });
    }

    // The UI speaks Toman; storage is integer Rial. Converted once, here, at
    // the boundary — a float Toman amount reaching the database is how a
    // balance ends up ending in .0000001.
    const dealValueRial =
      body.dealValueRial !== undefined
        ? Math.round(body.dealValueRial)
        : body.dealValueToman !== undefined
          ? tomanToRial(body.dealValueToman)
          : undefined;
    if (dealValueRial !== undefined && (!Number.isFinite(dealValueRial) || dealValueRial < 0)) {
      return NextResponse.json({ error: "deal_value_invalid" }, { status: 400 });
    }

    const result = await convertLead(
      session.businessId,
      id,
      {
        partyId: body.partyId,
        createDeal: body.createDeal === true,
        dealTitle: body.dealTitle,
        dealValueRial,
        dealExpectedCloseDate: body.dealExpectedCloseDate ?? null,
        acknowledgeDuplicates: body.acknowledgeDuplicates === true,
      },
      { name: session.fullName, userId: session.sub },
    );

    if (!result.ok) {
      if (result.error === "duplicates_found") {
        // 409, and the matches come back with it: the client needs them to
        // render the choice, and making it fetch them again would race with
        // whatever just changed.
        return NextResponse.json(
          { error: result.error, duplicates: result.duplicates },
          { status: 409 },
        );
      }
      const status = result.error === "already_converted" ? 409 : 404;
      return NextResponse.json({ error: result.error }, { status });
    }

    return NextResponse.json(result);
  },
);
