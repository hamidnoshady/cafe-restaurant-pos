import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin, requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { queryBusinesses, type BusinessQuery } from "@/lib/platform-service";
import { rootDomain } from "@/lib/host";
import { isIndustry } from "@/lib/industries";
import {
  provisionBusiness,
  validateProvisionBody,
  EmailPasswordMismatchError,
  SubdomainTakenError,
  type ProvisionRequestBody,
} from "@/lib/business-provisioning";
import { autoProvisionBusinessVirtualKey } from "@/lib/ai-gateway-service";

const VALID_STATUS = new Set(["active", "suspended", "archived"]);
const VALID_SORT = new Set(["newest", "oldest", "name", "orders", "members", "activity"]);
const VALID_ACTIVITY = new Set(["active", "idle"]);

/**
 * The console's business directory — filtered, sorted and paginated server-side
 * (any admin reads). Query params: `search`, `status`, `plan`, `industry`,
 * `from`/`to` (created-at ISO dates), `activity`, `sort`, `page`, `pageSize`.
 * `rootDomain` rides along because the console is a client component and cannot
 * read the server's environment — it needs the root to render a business's real
 * URL and to preview one before provisioning. The response carries `meta` with
 * pagination info (task section 25).
 */
export const GET = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const sp = request.nextUrl.searchParams;
  const statusParam = sp.get("status") ?? undefined;
  const sortParam = sp.get("sort") ?? undefined;
  const activityParam = sp.get("activity") ?? undefined;
  const industryParam = sp.get("industry") ?? undefined;
  const pageNum = Number(sp.get("page"));
  const pageSizeNum = Number(sp.get("pageSize"));

  const q: BusinessQuery = {
    search: sp.get("search") ?? undefined,
    status: statusParam && VALID_STATUS.has(statusParam) ? (statusParam as BusinessQuery["status"]) : undefined,
    plan: sp.get("plan") ?? undefined,
    industry: industryParam && isIndustry(industryParam) ? industryParam : undefined,
    createdFrom: sp.get("from") ?? undefined,
    createdTo: sp.get("to") ?? undefined,
    activity: activityParam && VALID_ACTIVITY.has(activityParam) ? (activityParam as BusinessQuery["activity"]) : undefined,
    sort: sortParam && VALID_SORT.has(sortParam) ? (sortParam as BusinessQuery["sort"]) : undefined,
    page: Number.isFinite(pageNum) && pageNum > 0 ? pageNum : undefined,
    pageSize: Number.isFinite(pageSizeNum) && pageSizeNum > 0 ? pageSizeNum : undefined,
  };

  const result = await queryBusinesses(q);
  return NextResponse.json({
    businesses: result.businesses,
    rootDomain: rootDomain(),
    meta: { total: result.total, page: result.page, pageSize: result.pageSize },
  });
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

    // A configured LiteLLM gateway now provisions the tenant key as part of
    // business creation; failures are recorded for retry and never undo the
    // otherwise successful tenant transaction.
    await autoProvisionBusinessVirtualKey(provisioned.businessId);

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
        // Phase 24 Wave 2 — the Owner's second factor, returned exactly once.
        //
        // A console-provisioned business is `connected`, so the Owner is
        // enrolled in SMS OTP to `ownerPhone` and there is no TOTP secret to
        // print; what there *is* is ten recovery codes, and this response is
        // the only place they will ever exist in plaintext. The operator hands
        // them to the Owner. Deliberately not written to the audit payload
        // below: an audit log that contains the credentials it is auditing is
        // worse than no audit log.
        mfa: {
          method: provisioned.totpSecret ? ("totp" as const) : ("sms_otp" as const),
          totpSecret: provisioned.totpSecret ?? null,
          totpUrl: provisioned.totpUrl ?? null,
          totpQr: provisioned.totpQr ?? null,
          recoveryCodes: provisioned.recoveryCodes ?? [],
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
