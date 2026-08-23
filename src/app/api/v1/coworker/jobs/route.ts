import { NextRequest, NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { requireCoworkerFeature } from "@/lib/coworker-api-guard";
import { apiKeyIssuerUserId } from "@/lib/api-keys-service";
import { coworkerErrorMessage, type CoworkerJobInput } from "@/lib/ai-coworker";
import { TEMPLATE_PARAM_ERROR_MESSAGES } from "@/lib/ai-coworker-templates";
import { createCoworkerJob, listCoworkerJobs } from "@/lib/ai-coworker-service";

function messageFor(code: string): string {
  return TEMPLATE_PARAM_ERROR_MESSAGES[code] ?? coworkerErrorMessage(code);
}

export const GET = withApiKeyScope(async (apiKey) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerRead);
  if (denied) return denied;
  const locked = await requireCoworkerFeature(apiKey.businessId);
  if (locked) return locked;
  return NextResponse.json({ jobs: await listCoworkerJobs(apiKey.businessId) });
});

export const POST = withApiKeyScope(async (apiKey, request: NextRequest) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.coworkerWrite);
  if (denied) return denied;
  const locked = await requireCoworkerFeature(apiKey.businessId);
  if (locked) return locked;

  let body: Partial<CoworkerJobInput>;
  try {
    body = (await request.json()) as Partial<CoworkerJobInput>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // A machine credential authors work under the authority of whoever issued
  // it; a key whose issuer is gone may read, but may not create a job whose
  // writes would then be attributable to nobody.
  const issuer = await apiKeyIssuerUserId(apiKey.apiKeyId);
  if (!issuer) return NextResponse.json({ error: "api_key_issuer_missing" }, { status: 409 });

  const created = await createCoworkerJob(
    apiKey.businessId,
    // A key defaults a job to the branch it was issued for, so a sub app that
    // says nothing about branches still writes to the right store room.
    { ...body, locationId: body.locationId ?? apiKey.locationId },
    issuer,
  );
  if (!created.ok) {
    return NextResponse.json(
      { error: created.errors[0], errors: created.errors, messages: created.errors.map(messageFor) },
      { status: 400 },
    );
  }
  return NextResponse.json({ job: created.job }, { status: 201 });
});
