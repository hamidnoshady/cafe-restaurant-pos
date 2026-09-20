import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import {
  LEAD_RATINGS,
  LEAD_STATUSES,
  listLeads,
  saveLead,
  type LeadRating,
  type LeadStatus,
} from "@/lib/crm-lead-service";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Leads — «سرنخ‌ها».
 *
 * A lead is an unqualified enquiry: someone who called, filled in a form or
 * was met at an exhibition. It is deliberately **not** a party. Creating a
 * customer record for every enquiry fills the directory with people who never
 * bought anything, and then every «چند مشتری داریم؟» answer is wrong and every
 * segment is polluted. A lead becomes a party at conversion, once, through
 * `POST /api/crm/leads/[id]/convert`.
 *
 * Filtering, searching and paging all happen in SQL. A client-side filter over
 * a fetched page is correct only until the table outgrows one response, and
 * then it is silently wrong in the worst way — a search that finds nothing
 * because the match was on page four.
 */

const MAX_PAGE_SIZE = 100;

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const status = search.get("status");
  const rating = search.get("rating");

  // Clamped, not trusted: `?limit=100000` is a denial-of-service against our
  // own database, and it arrives from a URL bar.
  const rawLimit = Number(search.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.trunc(rawLimit)), MAX_PAGE_SIZE) : 50;
  const rawOffset = Number(search.get("offset") ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;

  const result = await listLeads(session.businessId, {
    status:
      status === "open" || (status && (LEAD_STATUSES as readonly string[]).includes(status))
        ? (status as LeadStatus | "open")
        : undefined,
    rating:
      rating && (LEAD_RATINGS as readonly string[]).includes(rating) ? (rating as LeadRating) : undefined,
    ownerUserId: search.get("owner") ?? undefined,
    source: search.get("source") ?? undefined,
    search: search.get("q") ?? undefined,
    dueOnly: search.get("due") === "1",
    limit,
    offset,
  });

  // `total` is the count of rows matching the *filter*, not of the table, so
  // the pager agrees with the list. Returning a table-wide count next to a
  // filtered page produces «۱ تا ۵ از ۱۳» over five rows, and the user
  // reasonably concludes eight results are missing.
  return NextResponse.json({ ...result, limit, offset });
});

interface LeadBody {
  id?: string;
  name?: string;
  organization?: string;
  phone?: string | null;
  email?: string | null;
  source?: string;
  sourceDetail?: string;
  status?: string;
  rating?: string;
  ownerUserId?: string | null;
  ownerName?: string;
  notes?: string;
  nextAction?: string;
  nextActionAt?: string | null;
  qualificationReason?: string;
  disqualificationReason?: string;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmManage);
  if (error) return error;

  let body: LeadBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "lead_name_required" }, { status: 400 });

  if (body.status !== undefined && !(LEAD_STATUSES as readonly string[]).includes(body.status)) {
    return NextResponse.json({ error: "lead_status_invalid" }, { status: 400 });
  }
  if (body.rating !== undefined && !(LEAD_RATINGS as readonly string[]).includes(body.rating)) {
    return NextResponse.json({ error: "lead_rating_invalid" }, { status: 400 });
  }

  const lead = await saveLead(
    session.businessId,
    {
      id: body.id,
      name,
      organization: body.organization,
      phone: body.phone ?? null,
      email: body.email ?? null,
      // Unrecognised sources are normalised to `other` with the raw text kept
      // in `sourceDetail` rather than rejected — a UTM value from a campaign
      // nobody told the CRM about is information, not a validation error.
      source: body.source,
      sourceDetail: body.sourceDetail,
      status: body.status as LeadStatus | undefined,
      rating: body.rating as LeadRating | undefined,
      ownerUserId: body.ownerUserId ?? null,
      ownerName: body.ownerName,
      notes: body.notes,
      nextAction: body.nextAction,
      nextActionAt: body.nextActionAt ?? null,
      qualificationReason: body.qualificationReason,
      disqualificationReason: body.disqualificationReason,
    },
    { name: session.fullName, userId: session.sub },
  );

  if (!lead) {
    // saveLead returns null for a lead that no longer exists, or one already
    // converted (a converted lead is immutable — it has become a party, and
    // editing the husk it left behind would silently diverge from the record
    // people actually use).
    return NextResponse.json({ error: "lead_not_editable" }, { status: 409 });
  }

  return NextResponse.json({ lead }, { status: body.id ? 200 : 201 });
});
