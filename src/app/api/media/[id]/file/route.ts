import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getMediaConfig, isMediaStorageReady, readMediaObject } from "@/lib/media-service";
import { readMirroredMediaObject } from "@/lib/media-mirror";

/**
 * The object's bytes, served through the app: the browser never talks to the
 * bucket, so the S3 credential stays server-side and the tenant check
 * (`keyBelongsToBusiness`, inside readMediaObject) runs on every read.
 *
 * Images and videos render inline (the library grid's thumbnails and the
 * item pickers); everything else downloads — a "document" that turned out to
 * be active content must never execute on this origin.
 *
 * Every signed-in staff role may fetch *inline* kinds: the POS and waiter
 * tiles show catalogue photos, so a cashier used to get a 403 on every image
 * on the selling screen while the media library itself stays owner/manager.
 * Documents keep the stricter gate — the role check runs a second time once
 * the asset's kind is known.
 */
export const GET = withTenantScope(async (_request: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const { session, error } = await requirePermission(PERMISSIONS.mediaView);
  if (error) return error;
  const { id } = await context.params;

  const config = await getMediaConfig();
  let result: { asset: { kind: string; fileName: string; mimeType: string }; bytes: Buffer } | null = null;
  try {
    if (isMediaStorageReady(config)) result = await readMediaObject(session.businessId, id, config);
    // A paired site's snapshot carries media metadata, not cloud bucket
    // credentials. Fetch once over its scoped sync credential and keep a
    // checksum-verified local mirror for subsequent Internet outages.
    if (!result) result = await readMirroredMediaObject(session.businessId, id);
  } catch {
    return NextResponse.json({ error: "storage_error" }, { status: 502 });
  }
  if (!result) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });

  const { asset, bytes } = result;
  const inline = asset.kind === "image" || asset.kind === "video";
  if (!inline) {
    // Reading a document is a media-library action, not a selling-screen one.
    const restricted = await requirePermission(PERMISSIONS.mediaView);
    if (restricted.error) return restricted.error;
  }
  const fileName = encodeURIComponent(asset.fileName);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      // SVG can carry markup; force download for it despite being an "image".
      "Content-Type": asset.mimeType === "image/svg+xml" ? "application/octet-stream" : asset.mimeType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `${inline && asset.mimeType !== "image/svg+xml" ? "inline" : "attachment"}; filename*=UTF-8''${fileName}`,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
