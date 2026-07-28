import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import {
  getServerSyncConfig,
  getServerSyncState,
  listServerSyncDeadLetters,
  setServerSyncConfig,
} from "@/lib/server-sync";
import { resolveConfigUpdate, type ServerSyncConfigUpdateInput } from "@/lib/server-sync-config";

/**
 * Owner-only: configure the bidirectional server-to-server sync target
 * (the peer server's URL + shared bearer token) and read current sync status.
 *
 * On the café laptop this points at the VPS (https://pos.eshobe.com); the
 * same token must be set as REMOTE_SYNC_TOKEN in the VPS's environment so its
 * /api/server-sync/push and /pull endpoints accept the laptop's requests.
 */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const [config, syncState, deadLetters] = await Promise.all([
    getServerSyncConfig(session.businessId),
    getServerSyncState(session.businessId),
    listServerSyncDeadLetters(session.businessId),
  ]);
  // Never leak the token back to the client in full — mask it.
  const masked = config
    ? { ...config, token: config.token ? `${config.token.slice(0, 4)}…${config.token.slice(-4)}` : "" }
    : null;
  return NextResponse.json({ config: masked, syncState, deadLetters });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: ServerSyncConfigUpdateInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // GET only ever returns a masked token preview, so the client omits `token`
  // entirely unless the owner typed a new one — resolveConfigUpdate keeps the
  // existing one in that case, so toggling `enabled` or changing `batchSize`
  // doesn't force re-entering the secret every time.
  const existing = await getServerSyncConfig(session.businessId);
  const result = resolveConfigUpdate(existing, body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  await setServerSyncConfig(session.businessId, result.config);
  return NextResponse.json({ ok: true });
});
