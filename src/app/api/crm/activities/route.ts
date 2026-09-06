import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { createActivity, listActivities } from "@/lib/crm-service";
import { isActivityKind, type ActivityKind } from "@/lib/crm-shared";

/**
 * Activities — calls, visits, messages and tasks (Phase 36).
 *
 * One table for both "what happened" and "what needs doing", because they are
 * the same thing at different times: an activity with a future `dueAt` and no
 * `completedAt` *is* the task model. Two tables would have meant copying a
 * completed task into a history row, and then reconciling the two.
 *
 * Floor-accessible (`parties.manage`): the person who takes the call is the
 * person who should log it and tick off the callback. A task list only the
 * office can write to is a task list that stops matching reality by Tuesday.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesView);
  if (error) return error;

  const search = request.nextUrl.searchParams;
  const activities = await listActivities(session.businessId, {
    customerId: search.get("customerId") ?? undefined,
    dealId: search.get("dealId") ?? undefined,
    caseId: search.get("caseId") ?? undefined,
    openOnly: search.get("open") === "1",
    assignedTo: search.get("assignedTo") ?? undefined,
  });
  return NextResponse.json({ activities });
});

interface ActivityBody {
  customerId?: string | null;
  dealId?: string | null;
  caseId?: string | null;
  kind?: string;
  subject?: string;
  body?: string;
  dueAt?: string | null;
  assignedTo?: string;
  completed?: boolean;
}

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
  if (error) return error;

  let body: ActivityBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const subject = body.subject?.trim();
  if (!subject) return NextResponse.json({ error: "activity_subject_required" }, { status: 400 });
  if (!body.kind || !isActivityKind(body.kind)) {
    return NextResponse.json({ error: "activity_kind_invalid" }, { status: 400 });
  }

  const activity = await createActivity(session.businessId, {
    customerId: body.customerId ?? null,
    dealId: body.dealId ?? null,
    caseId: body.caseId ?? null,
    kind: body.kind as ActivityKind,
    subject,
    body: body.body,
    dueAt: body.dueAt ?? null,
    assignedTo: body.assignedTo,
    createdBy: session.fullName,
    completed: body.completed,
  });
  return NextResponse.json({ activity }, { status: 201 });
});
