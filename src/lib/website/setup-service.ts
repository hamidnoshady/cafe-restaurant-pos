/**
 * The CMS site-building wizard's state, and the build itself.
 *
 * DB-touching (per repo convention not unit-tested directly; the rules it
 * enforces are pure and live in `setup.ts`, which is). One row of
 * `website_setup` per business — the choices an owner made on the way to
 * having a site: which domain and whether we bought it, whether ArvanCloud
 * sits in front of it, what kind of site it is, and which plan it runs on.
 *
 * The division of labour is the one CLAUDE.md states and this file is where
 * it is easiest to break: **the CMS does site functions; the money is ours.**
 * So a domain order goes to the CMS's registrar (it holds the reseller
 * account) and the *fee* is recorded here through `billing-service.ts`, and
 * the build calls `provisionCmsWebsite` and then starts the subscription. The
 * CMS is never told what anything costs.
 */
import { query } from "../db";
import {
  buildReadiness,
  currentStep,
  EMPTY_WEBSITE_SETUP,
  isValidDomain,
  normalizeDomain,
  SITE_TYPES,
  type CdnProvider,
  type CdnStatus,
  type DomainMode,
  type DomainStatus,
  type SiteType,
  type WebsiteSetupState,
} from "./setup";
import { provisionCmsWebsite, cmsWebsiteState } from "../cms/website-service";
import { startWebsiteSubscription } from "./billing-service";

export type SetupResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface SetupRow extends Record<string, unknown> {
  step: WebsiteSetupState["stage"];
  domain: string | null;
  domain_mode: DomainMode;
  domain_status: DomainStatus;
  domain_reference: string | null;
  domain_years: number;
  cdn_provider: CdnProvider;
  cdn_status: CdnStatus;
  cdn_note: string | null;
  site_type: SiteType;
  site_name: string | null;
  plan_key: string | null;
  built_at: string | null;
  last_error: string | null;
}

const COLUMNS = `step, domain, domain_mode, domain_status, domain_reference, domain_years,
       cdn_provider, cdn_status, cdn_note, site_type, site_name, plan_key,
       built_at, last_error`;

function toState(row: SetupRow): WebsiteSetupState {
  return {
    stage: row.step,
    domain: row.domain,
    domainMode: row.domain_mode,
    domainStatus: row.domain_status,
    domainReference: row.domain_reference,
    domainYears: Number(row.domain_years) || 1,
    cdnProvider: row.cdn_provider,
    cdnStatus: row.cdn_status,
    cdnNote: row.cdn_note,
    siteType: row.site_type,
    siteName: row.site_name,
    planKey: row.plan_key,
    builtAt: row.built_at ? new Date(row.built_at).toISOString() : null,
    lastError: row.last_error,
  };
}

/**
 * The wizard's state for a business, creating the row on first read.
 *
 * A missing row is "has not started", not an error — which is why this never
 * throws and why the app home can call it for every business.
 */
export async function getWebsiteSetup(businessId: string): Promise<WebsiteSetupState> {
  const { rows } = await query<SetupRow>(
    `SELECT ${COLUMNS} FROM website_setup WHERE business_id = $1`,
    [businessId],
  );
  const row = rows[0];
  return row ? toState(row) : { ...EMPTY_WEBSITE_SETUP };
}

export interface WebsiteSetupPatch {
  domain?: string;
  domainMode?: DomainMode;
  domainYears?: number;
  cdnProvider?: CdnProvider;
  cdnStatus?: CdnStatus;
  cdnNote?: string | null;
  siteType?: SiteType;
  siteName?: string;
  planKey?: string | null;
}

/**
 * Record a step's answer. Validation returns an error *code* the API layer
 * maps to a status and the UI maps to Persian — the same contract
 * `connections-service.ts` and `cms/website-service.ts` use.
 *
 * A patch never advances `step` past what the answers justify: `currentStep`
 * derives it from the state, so re-opening the wizard on another device lands
 * on the same screen without a second source of truth to keep in step.
 */
export async function saveWebsiteSetup(
  businessId: string,
  patch: WebsiteSetupPatch,
): Promise<SetupResult<WebsiteSetupState>> {
  const current = await getWebsiteSetup(businessId);
  if (current.stage === "built") return { ok: false, error: "already_built" };

  const next: WebsiteSetupState = { ...current };

  if (patch.domain !== undefined) {
    const domain = normalizeDomain(patch.domain);
    if (!isValidDomain(domain)) return { ok: false, error: "invalid_domain" };
    // Choosing a different domain undoes the answer the registrar gave about
    // the old one; keeping `registered` here would show a green tick over a
    // domain nobody has bought.
    if (domain !== current.domain) {
      next.domainStatus = "pending";
      next.domainReference = null;
    }
    next.domain = domain;
  }
  if (patch.domainMode !== undefined) {
    if (patch.domainMode !== "own" && patch.domainMode !== "buy") return { ok: false, error: "invalid_domain_mode" };
    next.domainMode = patch.domainMode;
  }
  if (patch.domainYears !== undefined) {
    if (!Number.isInteger(patch.domainYears) || patch.domainYears < 1 || patch.domainYears > 5) {
      return { ok: false, error: "invalid_period" };
    }
    next.domainYears = patch.domainYears;
  }
  if (patch.cdnProvider !== undefined) {
    if (!["arvancloud", "cloudflare", "none"].includes(patch.cdnProvider)) {
      return { ok: false, error: "invalid_cdn_provider" };
    }
    next.cdnProvider = patch.cdnProvider;
    // «بدون CDN» is a decision, and the wizard records it as one rather than
    // leaving the step looking unanswered forever.
    if (patch.cdnProvider === "none") next.cdnStatus = "skipped";
    else if (next.cdnStatus === "skipped") next.cdnStatus = "pending";
  }
  if (patch.cdnStatus !== undefined) {
    if (!["pending", "requested", "active", "failed", "skipped"].includes(patch.cdnStatus)) {
      return { ok: false, error: "invalid_cdn_status" };
    }
    next.cdnStatus = patch.cdnStatus;
  }
  if (patch.cdnNote !== undefined) next.cdnNote = patch.cdnNote?.slice(0, 500) ?? null;
  if (patch.siteType !== undefined) {
    if (!SITE_TYPES.includes(patch.siteType)) return { ok: false, error: "invalid_type" };
    next.siteType = patch.siteType;
  }
  if (patch.siteName !== undefined) {
    const name = patch.siteName.trim();
    if (!name || name.length > 120) return { ok: false, error: "invalid_name" };
    next.siteName = name;
  }
  if (patch.planKey !== undefined) next.planKey = patch.planKey?.trim() || null;

  next.stage = currentStep(next);
  await persist(businessId, next);
  return { ok: true, data: next };
}

/** Records what the registrar answered about a domain order. */
export async function recordDomainOrder(
  businessId: string,
  input: { status: DomainStatus; reference: string | null },
): Promise<WebsiteSetupState> {
  const current = await getWebsiteSetup(businessId);
  const next: WebsiteSetupState = { ...current, domainStatus: input.status, domainReference: input.reference };
  if (next.stage !== "built") next.stage = currentStep(next);
  await persist(businessId, next);
  return next;
}

async function persist(businessId: string, state: WebsiteSetupState): Promise<void> {
  await query(
    `INSERT INTO website_setup
       (business_id, step, domain, domain_mode, domain_status, domain_reference, domain_years,
        cdn_provider, cdn_status, cdn_note, site_type, site_name, plan_key, built_at, last_error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (business_id) DO UPDATE SET
       step = EXCLUDED.step,
       domain = EXCLUDED.domain,
       domain_mode = EXCLUDED.domain_mode,
       domain_status = EXCLUDED.domain_status,
       domain_reference = EXCLUDED.domain_reference,
       domain_years = EXCLUDED.domain_years,
       cdn_provider = EXCLUDED.cdn_provider,
       cdn_status = EXCLUDED.cdn_status,
       cdn_note = EXCLUDED.cdn_note,
       site_type = EXCLUDED.site_type,
       site_name = EXCLUDED.site_name,
       plan_key = EXCLUDED.plan_key,
       built_at = EXCLUDED.built_at,
       last_error = EXCLUDED.last_error,
       updated_at = now()`,
    [
      businessId,
      state.stage,
      state.domain,
      state.domainMode,
      state.domainStatus,
      state.domainReference,
      state.domainYears,
      state.cdnProvider,
      state.cdnStatus,
      state.cdnNote,
      state.siteType,
      state.siteName,
      state.planKey,
      state.builtAt,
      state.lastError,
    ],
  );
}

/**
 * Step 4 — build the site.
 *
 * Order matters and is the whole reason this is one function rather than two
 * calls from a route: the site is created on the CMS first, and only a site
 * that exists starts a subscription. A business must never be billed for a
 * site whose provisioning failed, and the reverse — a site that exists with
 * nothing billing for it — is recoverable by the operator, so that is the
 * direction the failure is allowed to fall.
 */
export async function buildWebsite(
  businessId: string,
): Promise<SetupResult<{ setup: WebsiteSetupState; domain: string }>> {
  const state = await getWebsiteSetup(businessId);
  const readiness = buildReadiness(state);
  if (!readiness.ok) return { ok: false, error: "not_ready" };

  const existing = await cmsWebsiteState(businessId);
  if (existing) return { ok: false, error: "already_connected" };

  const provisioned = await provisionCmsWebsite(businessId, {
    name: state.siteName!.trim(),
    domain: state.domain!,
    type: state.siteType,
  });
  if (!provisioned.ok) {
    await persist(businessId, { ...state, lastError: provisioned.error });
    return { ok: false, error: provisioned.error };
  }

  const built: WebsiteSetupState = {
    ...state,
    stage: "built",
    builtAt: new Date().toISOString(),
    lastError: null,
  };
  await persist(businessId, built);

  // Billing is best-effort *for the response only*: the site exists either
  // way, and a subscription that failed to start is visible on the billing
  // section as «بدون اشتراک» rather than as a site nobody can open.
  if (state.planKey) {
    try {
      await startWebsiteSubscription(businessId, state.planKey);
    } catch {
      // Left to the billing section to surface; the build itself succeeded.
    }
  }

  return { ok: true, data: { setup: built, domain: state.domain! } };
}
