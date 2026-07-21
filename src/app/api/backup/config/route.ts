import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { validateBackupConfig } from "@/lib/backup";
import { getBackupConfig, getBackupConfigMasked, setBackupConfig } from "@/lib/backup-service";

/** Backup schedule/retention/cloud settings — Owner-only (they hold the keys). */
export async function GET() {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  return NextResponse.json({ config: await getBackupConfigMasked(session.businessId) });
}

export async function PUT(request: NextRequest) {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // Secrets are never echoed to the browser (see getBackupConfigMasked), so an
  // empty secret/passphrase in the submitted form means "keep the stored one".
  const current = await getBackupConfig(session.businessId);
  const cloud = (body.cloud ?? {}) as Record<string, unknown>;
  if (typeof cloud === "object" && cloud !== null) {
    if (!cloud.secretAccessKey) cloud.secretAccessKey = current.cloud.secretAccessKey;
    if (!cloud.passphrase) cloud.passphrase = current.cloud.passphrase;
  }

  const validated = validateBackupConfig({ ...body, cloud });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  await setBackupConfig(session.businessId, validated.config);
  return NextResponse.json({ ok: true });
}
