import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { setCustomerTag } from "@/lib/crm-service";

/**
 * Add or remove one tag on a customer (Phase 36).
 *
 * Deliberately *one* tag per call with an explicit `add`/`remove`, rather than
 * a PUT that takes the whole array. The existing `customer.note.add` action has
 * to warn the model, in its payload hint, that sending `notes` replaces every
 * previous note — that warning is the bug. An endpoint whose only vocabulary is
 * "add this one" and "remove this one" cannot silently erase the other tags,
 * whether the caller is the assistant, a future bulk tool, or a hand-written
 * fetch. Concurrency follows for free: two people tagging the same customer at
 * once both win, because neither sends a full array.
 *
 * `customers.manage`, same as notes: writing on someone's record is a change to
 * it, and the floor legitimately holds that permission.
 */
export const PATCH = withTenantScope(
  async (request: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { session, error } = await requirePermission(PERMISSIONS.customersManage);
    if (error) return error;

    let body: { tag?: string; action?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const tag = body.tag?.trim();
    if (!tag) return NextResponse.json({ error: "tag_required" }, { status: 400 });
    if (body.action !== "add" && body.action !== "remove") {
      return NextResponse.json({ error: "tag_action_invalid" }, { status: 400 });
    }

    const { id } = await params;
    const tags = await setCustomerTag(session.businessId, id, tag, body.action);
    if (tags === null) return NextResponse.json({ error: "customer_not_found" }, { status: 404 });
    return NextResponse.json({ tags });
  },
);
