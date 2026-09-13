import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getMediaConfig } from "@/lib/media-service";
import { normalizeKeyPrefix } from "@/lib/media";
import { s3Delete, s3Put } from "@/lib/s3-lite";

/**
 * «آزمایش اتصال» — writes a tiny probe object under the configured prefix and
 * deletes it again, so the console can tell a typo'd endpoint or a wrong
 * credential apart from a healthy connection before any tenant uploads.
 */
export const POST = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("backup.manage");
  if (error) return error;

  const config = await getMediaConfig();
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    return NextResponse.json({ ok: false, error: "incomplete_config" }, { status: 400 });
  }

  const key = `${normalizeKeyPrefix(config.keyPrefix)}connection-test/${Date.now()}.txt`;
  const s3 = {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };
  try {
    await s3Put(s3, key, Buffer.from("pos media connection test"));
    await s3Delete(s3, key);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: "connection_failed", detail: err instanceof Error ? err.message.slice(0, 300) : "" },
      { status: 502 },
    );
  }
});
