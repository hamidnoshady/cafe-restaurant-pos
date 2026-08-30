/**
 * `POST /api/cms/revalidate` — the receiver half of the CMS revalidation
 * webhook (eshobe-cms `src/lib/renderer-webhook.ts`).
 *
 * The CMS calls `REVALIDATE_WEBHOOK_URL` on every publish with an HMAC
 * signature keyed by its `PAYLOAD_SECRET`; this route verifies it over the
 * raw body, then purges this app's cached CMS slices by tag. The secret is
 * our `ESHOBE_CMS_WEBHOOK_SECRET` (set it to the CMS's `PAYLOAD_SECRET`).
 *
 * Fire-and-forget on the CMS side, so delivery is at-most-once: anything we
 * miss self-heals at the next cache freshness window.
 */
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

import { cmsWebhookSecret } from "@/lib/cms/config";
import {
  ESHOBE_SIGNATURE_HEADER,
  cmsPathTag,
  cmsSiteTag,
  verifyEshobeSignature,
  type CmsRevalidateNotice,
} from "@/lib/cms/webhook";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = cmsWebhookSecret(process.env);
  if (!secret) {
    return NextResponse.json(
      { error: "webhook not configured — set ESHOBE_CMS_WEBHOOK_SECRET" },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get(ESHOBE_SIGNATURE_HEADER);

  if (!verifyEshobeSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let notice: CmsRevalidateNotice;
  try {
    notice = JSON.parse(rawBody) as CmsRevalidateNotice;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof notice?.siteId !== "string" || !Array.isArray(notice.paths)) {
    return NextResponse.json({ error: "malformed body" }, { status: 400 });
  }

  revalidateTag(cmsSiteTag(notice.siteId));
  for (const path of notice.paths) {
    if (typeof path === "string" && path.startsWith("/")) {
      revalidateTag(cmsPathTag(notice.siteId, path));
    }
  }

  return NextResponse.json({ ok: true, revalidated: notice.paths.length + 1 });
}
