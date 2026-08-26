import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { validateBackupConfig } from "@/lib/backup";
import { getBackupConfig, getBackupConfigMasked, setBackupConfig } from "@/lib/backup-service";
import { isLocalOnly } from "@/lib/deployment-mode";

/** Backup schedule/retention/cloud settings — Owner-only (they hold the keys). */
export const GET = withTenantScope(async () => {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  return NextResponse.json({
    config: await getBackupConfigMasked(session.businessId),
    // A local-only install has no cloud story: the client hides the whole
    // S3 section, and the PUT below refuses to enable it.
    localOnly: await isLocalOnly(session.businessId),
  });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
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
  
  if (!body.passphrase) {
    body.passphrase = current.passphrase;
  }

  const validated = validateBackupConfig({ ...body, cloud });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  // A standalone install cannot use cloud backup: there is no platform to hold
  // the credentials, and the whole point of local mode is that nothing leaves
  // the machine. The local half of the schedule stays fully available.
  if (validated.config.cloud.enabled && (await isLocalOnly(session.businessId))) {
    return NextResponse.json({ error: "cloud_backup_unavailable_local" }, { status: 400 });
  }

  await setBackupConfig(session.businessId, validated.config);
  return NextResponse.json({ ok: true });
});
