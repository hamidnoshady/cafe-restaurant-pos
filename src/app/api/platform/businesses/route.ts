import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { listBusinesses } from "@/lib/platform-service";
import { rootDomain } from "@/lib/host";
import {
  provisionBusiness,
  validateProvisionBody,
  EmailPasswordMismatchError,
  SubdomainTakenError,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";

/**
 * Every business on the deployment — the console's landing list (any admin
 * reads). `rootDomain` rides along because the console is a client component
 * and cannot read the server's environment: it needs the root to render a
 * business's real URL and to preview one before provisioning.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ businesses: await listBusinesses(), rootDomain: rootDomain() });
});

/**
 * Provision a working business end-to-end: identity, owner membership, first
 * branch, and — because this is the console, not the setup wizard — the default
 * chart of accounts, so the owner can log straight in and sell (exit criterion
 * 1). Owner-only (`business.provision`), and audited before we return.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  let body: ProvisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  // The console is the one caller with a super-admin in front of it, so it is
  // the one caller required to name the business's address: `{subdomain}.$ROOT_DOMAIN`
  // is what the owner will be given, and it is typed in English by hand rather
  // than transliterated from a Persian business name.
  const validated = validateProvisionBody(body, { requireSubdomain: true });
  if (validated.input === null) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const input = validated.input;

  try {
    const provisioned = await provisionBusiness({
      ...input,
      seedChartOfAccounts: true,
    });


    await platformAudit({
      adminId: session.padmin,
      businessId: provisioned.businessId,
      action: "business.provision",
      entity: "business",
      entityId: provisioned.businessId,
      payload: {
        businessName: input.businessName,
        slug: provisioned.businessSlug,
        subdomain: provisioned.businessSubdomain,
        industry: input.industry,
        ownerEmail: input.email,
      },

    });

    return NextResponse.json(
      {
        business: {
          id: provisioned.businessId,
          slug: provisioned.businessSlug,
          subdomain: provisioned.businessSubdomain,
          locationId: provisioned.locationId,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof SubdomainTakenError) {
      // Someone else already answers on that host, or it is an old host of
      // theirs that still redirects. The admin picks another rather than
      // being silently given `acme-2`.
      return NextResponse.json({ error: "subdomain_taken" }, { status: 409 });
    }
    if (err instanceof EmailPasswordMismatchError) {
      // The email already belongs to a person, and a different password was
      // offered. Adding a business to their account must be authenticated as
      // them (see business-provisioning.ts).
      return NextResponse.json({ error: "email_password_mismatch" }, { status: 409 });
    }
    throw err;
  }
});
