import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import {
  getUpdateDistributionConfig,
  setUpdateDistributionConfig,
  clientVersionCompliance,
  type UpdateDistributionConfig,
} from "@/lib/platform-service";

/**
 * Super-admin surface for the desktop installer's update distribution — the
 * S3-compatible bucket `electron-updater` checks (see
 * docs/standalone-desktop-app.md), plus a read of which businesses' on-site
 * installs are current vs behind (src/lib/app-update.ts's per-business
 * status, aggregated across every business).
 *
 * Any active platform admin can view this (same "system.read"-style
 * visibility as the System page); only an owner can change the S3 config,
 * since it holds a real secret access key.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const [config, clients] = await Promise.all([getUpdateDistributionConfig(), clientVersionCompliance()]);
  // Never leak the secret key back to the client in full — mask it, same
  // convention as the server-sync token (src/app/api/server-sync/config/route.ts).
  const masked = config
    ? {
        ...config,
        s3SecretAccessKey: config.s3SecretAccessKey
          ? `${config.s3SecretAccessKey.slice(0, 4)}…${config.s3SecretAccessKey.slice(-4)}`
          : "",
      }
    : null;
  return NextResponse.json({ config: masked, clients });
});

interface UpdateConfigBody {
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  /** Present only when the owner typed a new one — GET only ever returns a masked preview. */
  s3SecretAccessKey?: string;
  publicBaseUrl?: string;
}

export const PUT = withPlatformScope(async (request: NextRequest) => {
  const guard = await requirePlatformCapability("updates.manage");
  if (guard.error) return guard.error;

  let body: UpdateConfigBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const s3Endpoint = body.s3Endpoint?.trim() ?? "";
  const s3Bucket = body.s3Bucket?.trim() ?? "";
  const s3AccessKeyId = body.s3AccessKeyId?.trim() ?? "";
  const publicBaseUrl = body.publicBaseUrl?.trim() ?? "";

  if (s3Endpoint && !/^https?:\/\//.test(s3Endpoint)) {
    return NextResponse.json({ error: "invalid_endpoint" }, { status: 400 });
  }
  if (publicBaseUrl && !/^https?:\/\//.test(publicBaseUrl)) {
    return NextResponse.json({ error: "invalid_public_base_url" }, { status: 400 });
  }

  // Keep the existing secret unless the owner actually typed a new one —
  // same reasoning as resolveConfigUpdate for server-sync's token.
  const existing = await getUpdateDistributionConfig();
  const secretProvided = typeof body.s3SecretAccessKey === "string" && body.s3SecretAccessKey.trim() !== "";
  const s3SecretAccessKey = secretProvided ? body.s3SecretAccessKey!.trim() : (existing?.s3SecretAccessKey ?? "");

  const config: UpdateDistributionConfig = { s3Endpoint, s3Bucket, s3AccessKeyId, s3SecretAccessKey, publicBaseUrl };
  await setUpdateDistributionConfig(config);

  await platformAudit({
    adminId: guard.session.padmin,
    action: "updates.config",
    entity: "platform_update_config",
    // Never put the secret anywhere near the audit log.
    payload: { s3Endpoint, s3Bucket, s3AccessKeyId, publicBaseUrl, secretRotated: secretProvided },
  });

  return NextResponse.json({ ok: true });
});
