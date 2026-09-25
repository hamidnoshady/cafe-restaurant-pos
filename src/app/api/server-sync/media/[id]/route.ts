import { NextRequest, NextResponse } from "next/server";
import { resolveSyncCredential } from "@/lib/server-sync";
import { getMediaConfig, isMediaStorageReady, readMediaObject } from "@/lib/media-service";
import { withTenant } from "@/lib/db";
import { deploymentRole } from "@/lib/deployment-role";

/** Authenticated cloud-to-site media mirror; bytes are scoped by the site token's business. */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (deploymentRole() !== "central") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const credential = token ? await resolveSyncCredential(token) : null;
  if (!credential) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const result = await withTenant(credential.businessId, async () => {
    const config = await getMediaConfig();
    if (!isMediaStorageReady(config)) return null;
    return readMediaObject(credential.businessId, id, config);
  }, { locationId: credential.locationId ?? null });
  if (!result) return NextResponse.json({ error: "asset_not_found" }, { status: 404 });
  return new NextResponse(new Uint8Array(result.bytes), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(result.bytes.byteLength),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
