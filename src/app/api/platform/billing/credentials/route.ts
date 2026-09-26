import { NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { createBillingServiceCredential, revokeBillingServiceCredential } from "@/lib/billing/runtime";
import { query } from "@/lib/db";

/** Issue or revoke a CMS usage credential. The secret is returned once. */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const { rows } = await query(
    `SELECT key_id, label, scope, created_at, revoked_at
       FROM billing_service_credentials
      ORDER BY created_at DESC
      LIMIT 50`,
  );
  return NextResponse.json({ credentials: rows });
});

export const POST = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const body = (await req.json().catch(() => null)) as { label?: string } | null;
  const created = await createBillingServiceCredential(body?.label?.trim() || "eshobe-cms");
  return NextResponse.json({ credential: created });
});

export const DELETE = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformCapability("billing.manage");
  if (error) return error;
  const keyId = new URL(req.url).searchParams.get("keyId");
  if (!keyId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  await revokeBillingServiceCredential(keyId);
  return NextResponse.json({ ok: true });
});
