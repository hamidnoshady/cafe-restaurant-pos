import { NextResponse } from "next/server";
import {
  ingestCmsUsageBatchBody,
  verifyBillingServiceRequest,
} from "@/lib/billing/runtime";
import { readBillingServiceHeaders } from "@/lib/billing/auth/verify-service-request";
import { billingLog } from "@/lib/billing/observability";

/**
 * CMS → platform usage ingest. The caller authenticates with a
 * billing.usage.write credential. site_id is resolved to a business here.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const headers = readBillingServiceHeaders(request);
  const verified = await verifyBillingServiceRequest(
    { ...headers, rawBody },
    "billing.usage.write",
  );
  if (!verified.ok) {
    billingLog("billing.ingest.rejected", { code: verified.code });
    return NextResponse.json({ error: verified.code }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const result = await ingestCmsUsageBatchBody(body);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  billingLog("billing.ingest.batch", {
    accepted: result.accepted,
    duplicates: result.duplicates,
    rejected: result.results.filter((row) => row.status === "rejected").length,
  });
  return NextResponse.json(result);
}
