import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { requireCoworkerFeature } from "@/lib/coworker-api-guard";
import { apiKeyIssuerUserId } from "@/lib/api-keys-service";
import { coworkerErrorMessage } from "@/lib/ai-coworker";
import { decideCoworkerRun, getCoworkerRun } from "@/lib/ai-coworker-service";

export const GET = withApiKeyScope(
  async (apiKey, _request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerRead);
    if (denied) return denied;
    const locked = await requireCoworkerFeature(apiKey.businessId);
    if (locked) return locked;
    const { id } = await context.params;
    const run = await getCoworkerRun(apiKey.businessId, id);
    if (!run) return NextResponse.json({ error: "coworker_run_not_found" }, { status: 404 });
    return NextResponse.json({ run });
  },
);

/**
 * Approving over the API applies real changes, which is why it needs
 * `coworker.write` and why the write is attributed to the key's issuer rather
 * than to the key. A sub app cannot approve on behalf of nobody.
 */
export const POST = withApiKeyScope(
  async (apiKey, request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerWrite);
    if (denied) return denied;
    const locked = await requireCoworkerFeature(apiKey.businessId);
    if (locked) return locked;
    const { id } = await context.params;

    let body: { decision?: unknown };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (body.decision !== "approve" && body.decision !== "reject") {
      return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
    }

    const issuer = await apiKeyIssuerUserId(apiKey.apiKeyId);
    if (!issuer) return NextResponse.json({ error: "api_key_issuer_missing" }, { status: 409 });

    const result = await decideCoworkerRun({
      businessId: apiKey.businessId,
      runId: id,
      decision: body.decision,
      actorUserId: issuer,
    });
    if (!result.ok) {
      const status = result.error === "coworker_run_not_found" ? 404 : 409;
      return NextResponse.json(
        { error: result.error, message: coworkerErrorMessage(result.error) },
        { status },
      );
    }
    return NextResponse.json({ run: result.run });
  },
);
