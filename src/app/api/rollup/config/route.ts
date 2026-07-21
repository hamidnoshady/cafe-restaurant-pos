import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getRollupConfig, getRollupSyncState, setRollupConfig } from "@/lib/rollup-service";

/** Local side: this location's push target (central URL + token) and current sync status. */
export async function GET() {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const [config, syncState] = await Promise.all([
    getRollupConfig(session.businessId),
    getRollupSyncState(session.businessId),
  ]);
  return NextResponse.json({ config, syncState });
}

export async function PUT(request: NextRequest) {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: { centralUrl?: string; token?: string; enabled?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const centralUrl = body.centralUrl?.trim() ?? "";
  const token = body.token?.trim() ?? "";
  const enabled = Boolean(body.enabled);
  if (enabled && (!centralUrl || !token)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (centralUrl && !/^https?:\/\//.test(centralUrl)) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  await setRollupConfig(session.businessId, { centralUrl, token, enabled });
  return NextResponse.json({ ok: true });
}
