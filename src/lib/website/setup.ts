/**
 * Building a site on the platform's CMS — the steps, in the order an owner
 * actually works in, and the rules that decide when each one is done.
 *
 * «اول دامنه، بعد CDN، بعد نوع سایت، آخر ساخت.»
 *
 *   1. دامنه   — the address. Either the business already owns it and will
 *                point DNS at the platform, or the platform's registrar buys
 *                it for them (and the fee is billed here, not by the CMS).
 *   2. CDN     — ArvanCloud in front of the site: the zone, the records and
 *                the certificate. Skippable, and saying so is a decision the
 *                wizard records rather than a step it silently drops.
 *   3. نوع سایت — معرفی کسب‌وکار / نمونه‌کار / فروشگاه. This is what the CMS
 *                is told at provision time, so it decides which blocks and
 *                which starter content the new site gets.
 *   4. ساخت    — the site is created on the CMS, its key is issued and stored,
 *                and the business is connected.
 *
 * Framework-free and DB-free on purpose: the order of the steps and the
 * question "may this business build yet?" are the parts worth pinning in a
 * unit test (setup.test.ts), and they must read the same in the wizard, in the
 * API guard and in the app home's progress line. The DB half is
 * `setup-service.ts`.
 *
 * The division of labour this encodes is the one CLAUDE.md states: the CMS
 * does site functions, and everything about *paying* for the site — the plan,
 * the domain fee, the renewal — is this app's. Nothing here calls the CMS.
 */

export const WEBSITE_SETUP_STEP_KEYS = ["domain", "cdn", "type", "build"] as const;
export type WebsiteSetupStepKey = (typeof WEBSITE_SETUP_STEP_KEYS)[number];

/** `built` is not a step; it is the state the wizard is in once step 4 ran. */
export type WebsiteSetupStage = WebsiteSetupStepKey | "built";

export const SITE_TYPES = ["business", "portfolio", "store"] as const;
export type SiteType = (typeof SITE_TYPES)[number];

export const SITE_TYPE_LABELS: Record<SiteType, string> = {
  business: "سایت معرفی کسب‌وکار",
  portfolio: "نمونه‌کار",
  store: "فروشگاه اینترنتی",
};

export const SITE_TYPE_HINTS: Record<SiteType, string> = {
  business: "صفحه‌های معرفی، تماس، وبلاگ و فرم — بدون سبد خرید.",
  portfolio: "نمایش کارها و پروژه‌ها، با صفحهٔ تماس.",
  store: "محصول، سبد خرید و پرداخت آنلاین، با همگام‌سازی قیمت و موجودی از صندوق.",
};

export const DOMAIN_MODES = ["own", "buy"] as const;
export type DomainMode = (typeof DOMAIN_MODES)[number];

export const DOMAIN_MODE_LABELS: Record<DomainMode, string> = {
  own: "دامنه دارم",
  buy: "دامنه بخرم",
};

export const CDN_PROVIDERS = ["arvancloud", "cloudflare", "none"] as const;
export type CdnProvider = (typeof CDN_PROVIDERS)[number];

export const CDN_PROVIDER_LABELS: Record<CdnProvider, string> = {
  arvancloud: "ابر آروان (ArvanCloud)",
  cloudflare: "Cloudflare",
  none: "بدون CDN",
};

export type DomainStatus = "pending" | "ordered" | "registered" | "failed";
export type CdnStatus = "pending" | "requested" | "active" | "failed" | "skipped";

/** The wizard's stored state — one row of `website_setup`, in wire shape. */
export interface WebsiteSetupState {
  stage: WebsiteSetupStage;
  domain: string | null;
  domainMode: DomainMode;
  domainStatus: DomainStatus;
  domainReference: string | null;
  domainYears: number;
  cdnProvider: CdnProvider;
  cdnStatus: CdnStatus;
  cdnNote: string | null;
  siteType: SiteType;
  siteName: string | null;
  planKey: string | null;
  builtAt: string | null;
  lastError: string | null;
}

export const EMPTY_WEBSITE_SETUP: WebsiteSetupState = {
  stage: "domain",
  domain: null,
  domainMode: "own",
  domainStatus: "pending",
  domainReference: null,
  domainYears: 1,
  cdnProvider: "arvancloud",
  cdnStatus: "pending",
  cdnNote: null,
  siteType: "business",
  siteName: null,
  planKey: null,
  builtAt: null,
  lastError: null,
};

export interface WebsiteSetupStep {
  key: WebsiteSetupStepKey;
  title: string;
  description: string;
}

export const WEBSITE_SETUP_STEPS: readonly WebsiteSetupStep[] = [
  {
    key: "domain",
    title: "دامنه",
    description: "آدرس سایت: دامنه‌ای که دارید را وصل کنید یا از همین‌جا بخرید.",
  },
  {
    key: "cdn",
    title: "CDN و DNS",
    description: "قرار دادن سایت پشت ابر آروان: زون، رکوردها و گواهی SSL.",
  },
  {
    key: "type",
    title: "نوع سایت",
    description: "معرفی کسب‌وکار، نمونه‌کار یا فروشگاه — بلوک‌ها و محتوای اولیه از این انتخاب می‌آید.",
  },
  {
    key: "build",
    title: "ساخت سایت",
    description: "ساخت سایت روی سایت‌ساز و اتصال آن به همین حساب.",
  },
];

/** Hostname shape, deliberately the same rule the CMS validates with. */
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

export function isValidDomain(value: string): boolean {
  const domain = normalizeDomain(value);
  return domain.length > 0 && domain.length <= 253 && DOMAIN_RE.test(domain);
}

/** The TLD of a domain, lower-cased and without its dot («ir», «com»). */
export function tldOf(value: string): string {
  const domain = normalizeDomain(value);
  const dot = domain.lastIndexOf(".");
  return dot === -1 ? "" : domain.slice(dot + 1);
}

/**
 * Is a step finished?
 *
 * A step is done when the *decision it asks for* has been made — not when some
 * external system has confirmed it. That distinction is what lets an owner buy
 * a domain on Monday, have it register on Wednesday and still get on with
 * choosing the site type in between: `domainStatus` is `ordered`, the domain
 * is chosen, the step is done, and the domain card keeps showing the registrar
 * state until it lands. The one thing that genuinely blocks is a *failed*
 * order, because then there is no address to build on.
 */
export function isStepComplete(state: WebsiteSetupState, step: WebsiteSetupStepKey): boolean {
  switch (step) {
    case "domain":
      return Boolean(state.domain && isValidDomain(state.domain) && state.domainStatus !== "failed");
    case "cdn":
      // «بدون CDN» is an answer. So is "asked for one" — the zone is created by
      // platform staff, and waiting for that must not block the build.
      return state.cdnProvider === "none"
        ? state.cdnStatus === "skipped" || state.cdnStatus === "pending"
        : state.cdnStatus === "requested" || state.cdnStatus === "active" || state.cdnStatus === "skipped";
    case "type":
      return SITE_TYPES.includes(state.siteType) && Boolean(state.siteName?.trim());
    case "build":
      return state.stage === "built" && Boolean(state.builtAt);
  }
}

/** The step the wizard should open on: the first unfinished one. */
export function currentStep(state: WebsiteSetupState): WebsiteSetupStepKey {
  for (const step of WEBSITE_SETUP_STEP_KEYS) {
    if (!isStepComplete(state, step)) return step;
  }
  return "build";
}

/** How many of the four steps are done — the progress line on the app home. */
export function completedStepCount(state: WebsiteSetupState): number {
  return WEBSITE_SETUP_STEP_KEYS.filter((step) => isStepComplete(state, step)).length;
}

export type BuildReadiness = { ok: true } | { ok: false; reason: string };

/**
 * May this business build its site now?
 *
 * Returns the *Persian* reason rather than a code, because there is exactly
 * one caller shape for it — the wizard's build button and the route that
 * backs it — and every reason here is something the owner can act on
 * themselves. A refusal from the CMS is a different thing and keeps the
 * error-code contract the rest of `src/lib/cms` uses.
 */
export function buildReadiness(state: WebsiteSetupState): BuildReadiness {
  if (state.stage === "built") return { ok: false, reason: "این کسب‌وکار سایت ساخته‌شده دارد." };
  if (!state.domain || !isValidDomain(state.domain)) {
    return { ok: false, reason: "اول یک دامنهٔ معتبر انتخاب کنید." };
  }
  if (state.domainStatus === "failed") {
    return { ok: false, reason: "ثبت دامنه ناموفق بود؛ دامنهٔ دیگری انتخاب کنید یا دوباره سفارش دهید." };
  }
  if (!isStepComplete(state, "cdn")) {
    return { ok: false, reason: "تکلیف CDN را روشن کنید: فعال‌سازی آروان یا «بدون CDN»." };
  }
  if (!isStepComplete(state, "type")) {
    return { ok: false, reason: "نوع سایت و نام آن را انتخاب کنید." };
  }
  return { ok: true };
}

/**
 * The DNS a domain needs, in the two shapes an owner may be asked for.
 *
 * Pure so the wizard can show the instruction before anything is provisioned —
 * this is the one screen a person reads while logged into their registrar's
 * panel on a phone, so it must not depend on a live call succeeding first.
 */
export interface DnsInstruction {
  kind: "nameservers" | "records";
  nameservers: string[];
  records: { type: "A" | "CNAME"; name: string; value: string }[];
}

export function dnsInstruction(input: {
  domain: string;
  cdnProvider: CdnProvider;
  cmsHost: string;
  nameservers?: string[];
  cmsAddress?: string;
}): DnsInstruction {
  const domain = normalizeDomain(input.domain);
  if (input.cdnProvider !== "none" && (input.nameservers?.length ?? 0) > 0) {
    return { kind: "nameservers", nameservers: input.nameservers!, records: [] };
  }
  // Without a CDN in front, the domain points at the CMS itself: an A record
  // when we know the address, a CNAME to the CMS host when we do not.
  const value = input.cmsAddress ?? input.cmsHost;
  const type: "A" | "CNAME" = input.cmsAddress ? "A" : "CNAME";
  return {
    kind: "records",
    nameservers: [],
    records: [
      { type, name: domain, value },
      { type: "CNAME", name: `www.${domain}`, value: domain },
    ],
  };
}
