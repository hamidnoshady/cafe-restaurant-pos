import { NextResponse } from "next/server";
import { ingestCmsUsageBatch, verifyBillingServiceRequest, type IngestEvent } from "@/lib/billing/runtime";
import { billingLog } from "@/lib/billing/observability";

/**
 * CMS → platform usage ingest. The caller authenticates with a
 * billing.usage.write credential. site_id is resolved to a business here.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const verified = await verifyBillingServiceRequest({
    keyId: request.headers.get("x-billing-key-id") ?? "",
    timestamp: request.headers.get("x-billing-timestamp") ?? "",
    nonce: request.headers.get("x-billing-nonce") ?? "",
    signature: request.headers.get("x-billing-signature") ?? "",
    rawBody,
  });
  if (!verified.ok) {
    billingLog("billing.ingest.rejected", { code: verified.code });
    return NextResponse.json({ error: verified.code }, { status: 401 });
  }

  let body: { source?: unknown; events?: unknown };
  try {
    body = JSON.parse(rawBody) as { source?: unknown; events?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.source !== "eshobe-cms" || !Array.isArray(body.events)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await ingestCmsUsageBatch(body.events as IngestEvent[]);
  billingLog("billing.ingest.batch", {
    accepted: result.accepted,
    duplicates: result.duplicates,
    rejected: result.rejected.length,
  });
  return NextResponse.json(result);
}
