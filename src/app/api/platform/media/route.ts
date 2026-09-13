import { NextRequest, NextResponse } from "next/server";
import { platformAudit, requirePlatformAdmin, requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { clientIpFrom } from "@/lib/rate-limit";
import { maskMediaConfig, validateMediaConfigInput } from "@/lib/media";
import { getMediaConfig, saveMediaConfig } from "@/lib/media-service";
import { query } from "@/lib/db";

/**
 * The deployment-wide media storage settings (migration 0149): the one
 * S3/Parspack connection every tenant's media lands in, and the daily
 * storage price policy (flat base + per-GB above a free quota) the billing
 * tick charges business wallets with.
 *
 * Readable by any platform admin — usage and price are what `support` needs
 * when a business asks «چرا امروز کم شد؟» — but every secret is masked, so a
 * read never returns the S3 secret key. Writes need `system.manage`-class
 * custody; this uses `backup.manage`, the capability that already governs the
 * deployment's other S3 connection (the backup mirror) for exactly the same
 * kind of credential.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const config = await getMediaConfig();
  const { rows } = await query<{ businesses: string; assets: string; bytes: string }>(
    `SELECT COUNT(DISTINCT business_id) AS businesses, COUNT(*) AS assets, COALESCE(SUM(byte_size), 0) AS bytes
       FROM media_assets`,
  );
  return NextResponse.json({
    config: maskMediaConfig(config),
    usage: {
      businesses: Number(rows[0]?.businesses ?? 0),
      assets: Number(rows[0]?.assets ?? 0),
      bytes: Number(rows[0]?.bytes ?? 0),
    },
  });
});

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("backup.manage");
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const before = await getMediaConfig();
  const result = validateMediaConfigInput(body, before);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await saveMediaConfig(result.config, session.padmin);

  await platformAudit({
    adminId: session.padmin,
    action: "platform_media.config.update",
    entity: "platform_media_config",
    payload: {
      enabled: result.config.enabled,
      endpointSet: Boolean(result.config.endpoint),
      bucket: result.config.bucket,
      keyPrefix: result.config.keyPrefix,
      billingEnabled: result.config.billingEnabled,
      dailyFlatRial: result.config.dailyFlatRial,
      dailyPerGbRial: result.config.dailyPerGbRial,
      freeQuotaMb: result.config.freeQuotaMb,
      enhanceModel: result.config.enhanceModel,
      enhancePriceRial: result.config.enhancePriceRial,
      // Which secrets moved, never what they were.
      secretsChanged: { secretAccessKey: before.secretAccessKey !== result.config.secretAccessKey },
    },
    ipAddress: (request as unknown as { ip?: string }).ip ?? clientIpFrom(request.headers, 0),
    userAgent: request.headers.get("user-agent"),
  });

  return NextResponse.json({ config: maskMediaConfig(result.config) });
});
