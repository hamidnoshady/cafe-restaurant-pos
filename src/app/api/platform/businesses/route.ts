import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit } from "@/lib/platform-auth";
import { listBusinesses } from "@/lib/platform-service";
import {
  provisionBusiness,
  validateProvisionBody,
  EmailPasswordMismatchError,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";

/** Every business on the deployment — the console's landing list (any admin reads). */
export async function GET() {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ businesses: await listBusinesses() });
}

/**
 * Provision a working business end-to-end: identity, owner membership, first
 * branch, and — because this is the console, not the setup wizard — the default
 * chart of accounts, so the owner can log straight in and sell (exit criterion
 * 1). Owner-only (`business.provision`), and audited before we return.
 */
export async function POST(request: NextRequest) {
  const { session, error } = await requirePlatformCapability("business.provision");
  if (error) return error;

  let body: ProvisionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const validated = validateProvisionBody(body);
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
        ownerEmail: input.email,
      },

    });

    return NextResponse.json(
      {
        business: {
          id: provisioned.businessId,
          slug: provisioned.businessSlug,
          locationId: provisioned.locationId,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof EmailPasswordMismatchError) {
      // The email already belongs to a person, and a different password was
      // offered. Adding a business to their account must be authenticated as
      // them (see business-provisioning.ts).
      return NextResponse.json({ error: "email_password_mismatch" }, { status: 409 });
    }
    throw err;
  }
}
