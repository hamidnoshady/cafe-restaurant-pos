import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { updateMenuItem } from "@/lib/menu-service";
import { validateMenuItemPatch, type MenuItemPatchInput } from "@/lib/menu-validation";

/** Updates one menu item only when it belongs to the key's branch. */
export const PATCH = withApiKeyScope(
  async (apiKey, request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.menuWrite);
    if (denied) return denied;

    const { id } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    // An API key's JSON is exactly as untrusted as the dashboard's; the same
    // runtime schema rejects what the interactive PATCH would reject.
    const input: { ok: true; value: MenuItemPatchInput } | { ok: false; error: string } =
      validateMenuItemPatch(body);
    if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

    const result = await updateMenuItem(apiKey.locationId, id, input.value, apiKey.businessId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  },
);
