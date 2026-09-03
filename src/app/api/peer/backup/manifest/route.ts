import { NextRequest, NextResponse } from "next/server";
import {
  authorizePeerRequest,
  buildServeManifest,
  getPlatformBackupConfig,
} from "@/lib/platform-backup-service";

/**
 * What this server is willing to hand to another server, and the numbers that
 * describe it (migration 0132).
 *
 * Server-to-server, bearer-authenticated, never session-authenticated — the
 * same shape as `/api/server-sync/pull`, including why it is in
 * `middleware.ts`'s public list: the caller is a machine migrating onto this
 * one, which by definition has no cookie here.
 *
 * Two things this refuses to be:
 *
 *   • a discovery endpoint when serving is off — a disabled deployment answers
 *     404, the same answer as "no such path", so the console's switch genuinely
 *     closes the surface rather than leaving a 401 to probe;
 *   • a list of arbitrary files — the manifest names artifacts from this
 *     server's own backup directory that a successful run recorded, so there is
 *     nothing here that `/api/peer/backup/download` cannot already serve.
 *
 * `no-store` on both directions: a cached manifest would advertise an artifact
 * retention has since pruned, and a stale one is how a restore starts and then
 * fails at download time.
 */
export const GET = async (request: NextRequest) => {
  const config = await getPlatformBackupConfig();
  if (!config.servingEnabled) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const authorized = await authorizePeerRequest(request.headers);
  if ("unauthorized" in authorized) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const manifest = await buildServeManifest();
    return NextResponse.json(manifest, {
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex" },
    });
  } catch (err) {
    // A peer that cannot read our schema should hear "unavailable", not get a
    // stack trace — and should not be able to tell the difference between "no
    // database" and "no permission" beyond the status code.
    console.error("peer backup manifest failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "manifest_unavailable" }, { status: 503 });
  }
};
