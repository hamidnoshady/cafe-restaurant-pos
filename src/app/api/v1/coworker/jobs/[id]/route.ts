import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { requireCoworkerFeature } from "@/lib/coworker-api-guard";
import { apiKeyIssuerUserId } from "@/lib/api-keys-service";
import { coworkerErrorMessage, type CoworkerJobInput } from "@/lib/ai-coworker";
import { TEMPLATE_PARAM_ERROR_MESSAGES } from "@/lib/ai-coworker-templates";
import { deleteCoworkerJob, updateCoworkerJob } from "@/lib/ai-coworker-service";

function messageFor(code: string): string {
  return TEMPLATE_PARAM_ERROR_MESSAGES[code] ?? coworkerErrorMessage(code);
}

export const PATCH = withApiKeyScope(
  async (apiKey, request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerWrite);
    if (denied) return denied;
    const locked = await requireCoworkerFeature(apiKey.businessId);
    if (locked) return locked;
    const { id } = await context.params;

    let body: Partial<CoworkerJobInput>;
    try {
      body = (await request.json()) as Partial<CoworkerJobInput>;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const issuer = await apiKeyIssuerUserId(apiKey.apiKeyId);
    if (!issuer) return NextResponse.json({ error: "api_key_issuer_missing" }, { status: 409 });

    const updated = await updateCoworkerJob(apiKey.businessId, id, body, issuer);
    if (!updated.ok) {
      const status = updated.errors.includes("coworker_job_not_found") ? 404 : 400;
      return NextResponse.json(
        { error: updated.errors[0], errors: updated.errors, messages: updated.errors.map(messageFor) },
        { status },
      );
    }
    return NextResponse.json({ job: updated.job });
  },
);

export const DELETE = withApiKeyScope(
  async (apiKey, _request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerWrite);
    if (denied) return denied;
    const locked = await requireCoworkerFeature(apiKey.businessId);
    if (locked) return locked;
    const { id } = await context.params;
    const removed = await deleteCoworkerJob(apiKey.businessId, id);
    if (!removed) return NextResponse.json({ error: "coworker_job_not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  },
);
