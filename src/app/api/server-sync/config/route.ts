import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getServerSyncConfig, getServerSyncState, setServerSyncConfig } from "@/lib/server-sync";

/**
 * Owner-only: configure the bidirectional server-to-server sync target
 * (the peer server's URL + shared bearer token) and read current sync status.
 *
 * On the café laptop this points at the VPS (https://pos.eshobe.com); the
 * same token must be set as REMOTE_SYNC_TOKEN in the VPS's environment so its
 * /api/server-sync/push and /pull endpoints accept the laptop's requests.
 */
export async function GET() {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const [config, syncState] = await Promise.all([
    getServerSyncConfig(session.businessId),
    getServerSyncState(session.businessId),
  ]);
  // Never leak the token back to the client in full — mask it.
  const masked = config
    ? { ...config, token: config.token ? `${config.token.slice(0, 4)}…${config.token.slice(-4)}` : "" }
    : null;
  return NextResponse.json({ config: masked, syncState });
}

export async function PUT(request: NextRequest) {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { remoteUrl?: string; token?: string; enabled?: boolean; batchSize?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const remoteUrl = body.remoteUrl?.trim() ?? "";
  const token = body.token?.trim() ?? "";
  const enabled = Boolean(body.enabled);
  const batchSize = Number.isFinite(body.batchSize) ? Math.min(Math.max(Number(body.batchSize), 1), 200) : 100;

  if (enabled && (!remoteUrl || !token)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (remoteUrl && !/^https?:\/\//.test(remoteUrl)) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }
  if (token && token.length < 16) {
    return NextResponse.json({ error: "token_too_short" }, { status: 400 });
  }

  await setServerSyncConfig(session.businessId, { remoteUrl, token, enabled, batchSize });
  return NextResponse.json({ ok: true });
}
