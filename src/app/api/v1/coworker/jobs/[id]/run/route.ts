import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { requireCoworkerFeature } from "@/lib/coworker-api-guard";
import { coworkerErrorMessage } from "@/lib/ai-coworker";
import { runCoworkerJobNow } from "@/lib/ai-coworker-service";

export const POST = withApiKeyScope(
  async (apiKey, _request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerWrite);
    if (denied) return denied;
    const locked = await requireCoworkerFeature(apiKey.businessId);
    if (locked) return locked;
    const { id } = await context.params;

    const result = await runCoworkerJobNow(apiKey.businessId, id);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, message: coworkerErrorMessage(result.error) },
        { status: 404 },
      );
    }
    return NextResponse.json({ runIds: result.runIds });
  },
);
