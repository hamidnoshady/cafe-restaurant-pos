import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { getPushConfig } from "@/lib/notifications-service";

/**
 * The VAPID public key a browser needs before it can create a subscription.
 *
 * Only the public half, and only to a signed-in member: the key is not a secret
 * — it ends up inside every subscription a browser mints — but there is no
 * reason to hand an anonymous caller the identity of this deployment's sender.
 *
 * Answers `configured: false` rather than failing when the deployment has no
 * key pair, so the settings screen can say «روی این سرور آماده نیست» and leave
 * the rest of the page working.
 */
export const GET = withTenantScope(async () => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const config = await getPushConfig();
  return NextResponse.json(
    config ? { configured: true, publicKey: config.publicKey } : { configured: false, publicKey: null },
  );
});
