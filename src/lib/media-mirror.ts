import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { query } from "./db";
import { getServerSyncConfig } from "./server-sync";

const UUID = /^[0-9a-f-]{36}$/i;
function cacheRoot(): string {
  return process.env.MEDIA_MIRROR_DIR?.trim() || path.join(process.cwd(), ".data", "media-mirror");
}
function cachePath(businessId: string, assetId: string): string {
  if (!UUID.test(businessId) || !UUID.test(assetId)) throw new Error("invalid_media_identity");
  return path.join(cacheRoot(), businessId, assetId);
}

interface MirrorAsset extends Record<string, unknown> {
  id: string; file_name: string; mime_type: string; byte_size: string; sha256: string; kind: string;
}

/** Reads a verified local mirror, fetching it over the existing site credential once when absent. */
export async function readMirroredMediaObject(businessId: string, assetId: string): Promise<{
  asset: { kind: string; fileName: string; mimeType: string }; bytes: Buffer;
} | null> {
  const result = await query<MirrorAsset>(
    `SELECT id::text,file_name,mime_type,byte_size::text,sha256,kind
       FROM media_assets WHERE id=$1 AND business_id=$2`,
    [assetId, businessId],
  );
  const asset = result.rows[0];
  if (!asset) return null;
  const target = cachePath(businessId, assetId);
  const verify = (bytes: Buffer): boolean =>
    bytes.byteLength === Number(asset.byte_size) && createHash("sha256").update(bytes).digest("hex") === asset.sha256;
  try {
    const cached = await readFile(target);
    if (verify(cached)) return { asset: { kind: asset.kind, fileName: asset.file_name, mimeType: asset.mime_type }, bytes: cached };
  } catch { /* cache miss */ }

  const config = await getServerSyncConfig(businessId);
  if (!config?.remoteUrl || !config.token) return null;
  const response = await fetch(`${config.remoteUrl.replace(/\/+$/, "")}/api/server-sync/media/${assetId}`, {
    headers: { authorization: `Bearer ${config.token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verify(bytes)) throw new Error("media_mirror_integrity_failed");
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
  return { asset: { kind: asset.kind, fileName: asset.file_name, mimeType: asset.mime_type }, bytes };
}
