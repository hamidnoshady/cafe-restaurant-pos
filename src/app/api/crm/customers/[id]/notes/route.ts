import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  addCustomerNote,
  deleteCustomerNote,
  listCustomerNotes,
  toggleNotePin,
} from "@/lib/crm-service";

/**
 * Notes on a customer (Phase 36).
 *
 * A separate table from `customers.notes`, which is one free-text field on the
 * record and stays what it is (an address hint, an allergy). These are dated,
 * attributed, individually pinnable entries — «تماس گرفت، از تأخیر ناراضی بود»
 * — and the difference matters because the second kind is evidence with an
 * author and the first is a label.
 *
 * `parties.manage`, not `parties.view`: writing on someone's record is a
 * change to it. The floor holds that permission, which is the point — the
 * person who took the call is the person who should write the note.
 */
export const GET = withTenantScope(
  async (_request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesView);
    if (error) return error;

    const { id } = await params;
    return NextResponse.json({ notes: await listCustomerNotes(session.businessId, id) });
  },
);

export const POST = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
    if (error) return error;

    let body: { body?: string; isPinned?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const text = body.body?.trim();
    if (!text) return NextResponse.json({ error: "note_body_required" }, { status: 400 });

    const { id } = await params;
    const note = await addCustomerNote(session.businessId, id, {
      body: text,
      isPinned: body.isPinned,
      createdBy: session.fullName,
    });
    return NextResponse.json({ note }, { status: 201 });
  },
);

/** Pin or unpin a note — `noteId` in the body, since the note is addressed under its customer. */
export const PATCH = withTenantScope(
  async (request: NextRequest) => {
    const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
    if (error) return error;

    let body: { noteId?: string; isPinned?: boolean };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (!body.noteId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

    const updated = await toggleNotePin(session.businessId, body.noteId, body.isPinned === true);
    if (!updated) return NextResponse.json({ error: "note_not_found" }, { status: 404 });
    return NextResponse.json({ result: "updated" });
  },
);

export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.partiesManage);
  if (error) return error;

  const noteId = request.nextUrl.searchParams.get("noteId");
  if (!noteId) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const deleted = await deleteCustomerNote(session.businessId, noteId);
  if (!deleted) return NextResponse.json({ error: "note_not_found" }, { status: 404 });
  return NextResponse.json({ result: "deleted" });
});
