import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { authorizePeerRequest, getPlatformBackupConfig, resolveServeableArtifact } from "@/lib/platform-backup-service";

/**
 * Stream one backup artifact to an authorized peer (migration 0132).
 *
 * The care here is all about the filename that arrives in the query string:
 *
 *   • `resolveServeableArtifact` refuses anything that is not exactly this
 *     product's artifact grammar — no separator, no traversal, no other file in
 *     the directory (which may hold a `.tmp` of a dump in progress, or anything
 *     else an operator left there);
 *   • the path is then built by joining a *validated* single segment under the
 *     configured directory, and `fs.stat` confirms it is a regular file;
 *   • the body streams from disk instead of buffering, so a large database does
 *     not become a large allocation in the request handler;
 *   • `X-Backup-Sha256` carries the checksum the run recorded, which is what the
 *     pull side compares its own hash against. A peer that ignores the header
 *     still cannot be lied to by it, because the manifest's declared checksum is
 *     checked separately.
 *
 * Serving disabled answers 404 like the manifest endpoint does, and a revoked or
 * expired token answers 401 — there is no third state where a file leaks.
 */
export const GET = async (request: NextRequest) => {
  // Checked before the token, in the same order the manifest endpoint uses, so
  // that "serving is off" is the one state where this path answers 404 to
  // *everybody* — an unauthenticated probe cannot tell a disabled deployment from
  // one that has no such route, and cannot use the 401 as a way to enumerate
  // which installs have backup serving switched on.
  const config = await getPlatformBackupConfig();
  if (!config.servingEnabled) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const authorized = await authorizePeerRequest(request.headers);
  if ("unauthorized" in authorized) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const artifact = request.nextUrl.searchParams.get("artifact") ?? "";
  const resolved = await resolveServeableArtifact(artifact);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: resolved.status });
  }

  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": String(resolved.sizeBytes),
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
    "content-disposition": `attachment; filename="${artifact.replace(/[^A-Za-z0-9._-]/g, "")}"`,
  };
  if (resolved.sha256) headers["x-backup-sha256"] = resolved.sha256;

  const stream = createReadStream(resolved.filePath);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
};
