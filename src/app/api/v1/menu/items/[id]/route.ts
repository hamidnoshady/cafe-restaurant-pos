import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { type MenuItemPatchInput, updateMenuItem } from "@/lib/menu-service";

/** Updates one menu item only when it belongs to the key's branch. */
export const PATCH = withApiKeyScope(
  async (apiKey, request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.menuWrite);
    if (denied) return denied;

    const { id } = await context.params;
    let body: MenuItemPatchInput;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const result = await updateMenuItem(apiKey.locationId, id, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  },
);
