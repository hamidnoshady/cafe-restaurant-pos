/**
 * Business slugs — the short, URL-safe, human-quotable handle for a tenant.
 *
 * The slug is now purely internal: it names a business in stored references
 * and in the retired `/{slug}/dashboard` URLs that still get redirected, but
 * it is no longer part of any address the app generates. The *public* name is
 * `businesses.subdomain`, which a super-admin types in English by hand — see
 * `validateSubdomain` below and the console's add form. Business names in this
 * product are overwhelmingly Persian, so this transliterates Persian/Arabic
 * letters to Latin rather than keeping them as-is: a slug is meant to be a
 * plain, ASCII, easy-to-type identifier, not the display name with hyphens.
 *
 * The mapping is an approximation: ordinary Persian writing omits short
 * vowels, so this can't reconstruct pronunciation exactly. It only needs to
 * be deterministic, which it is.
 *
 * Framework-free and pure — covered by slug.test.ts.
 */

/** Persian/Arabic letter → Latin, applied before the final ASCII-only filter. */
const TRANSLITERATION: Record<string, string> = {
  "آ": "a",
  "ا": "a",
  "ب": "b",
  "پ": "p",
  "ت": "t",
  "ث": "s",
  "ج": "j",
  "چ": "ch",
  "ح": "h",
  "خ": "kh",
  "د": "d",
  "ذ": "z",
  "ر": "r",
  "ز": "z",
  "ژ": "zh",
  "س": "s",
  "ش": "sh",
  "ص": "s",
  "ض": "z",
  "ط": "t",
  "ظ": "z",
  "ع": "",
  "غ": "gh",
  "ف": "f",
  "ق": "q",
  "ک": "k",
  "گ": "g",
  "ل": "l",
  "م": "m",
  "ن": "n",
  "و": "v",
  "ه": "h",
  "ی": "y",
  "ئ": "y",
  "ء": "",
  "ة": "h",
};

function transliterate(text: string): string {
  return [...text].map((ch) => TRANSLITERATION[ch] ?? ch).join("");
}

/** Characters allowed in a slug: ASCII alphanumerics and hyphens. */
const ALLOWED = /[^a-z0-9-]/g;

/** Fallback stem when a name reduces to nothing usable. */
export const SLUG_FALLBACK = "biz";

export const MAX_SLUG_LENGTH = 48;

/**
 * Top-level segments the app itself routes on, plus (since Phase 23) the host
 * labels the deployment itself answers on.
 *
 * The path-level entries are the original reason this list exists: a business
 * slug prefixed the dashboard URL (`/{slug}/dashboard/...`), so a slug that
 * collided with one of these would be ambiguous with a real route. That URL
 * form is retired but still redirected, so the entries stay.
 *
 * The host-level entries are the ones that matter now, and they are a
 * different kind of collision. Every business is served from
 * `{subdomain}.{ROOT_DOMAIN}`, and the deployment
 * reserves some of those labels for itself: `admin` is the platform console's
 * own host, the apex is the "which business?" router, and `www`/`api`/`mail`
 * are the names an operator will inevitably want for the deployment rather
 * than for a tenant. A business handed one of these would shadow it, under a
 * wildcard certificate that covers it perfectly happily.
 *
 * Treated as already "taken" in `uniqueSlug` so a business named e.g. "API"
 * gets "api-2" instead of colliding with `/api`.
 */
export const RESERVED_SLUGS = [
  // Path-level: top-level route segments.
  "dashboard",
  "api",
  "login",
  "welcome",
  "invite",
  "platform",
  "setup",
  "_next",
  "favicon.ico",
  // Host-level (Phase 23): labels the deployment answers on itself.
  "admin",
  "www",
  "app",
  "mail",
  "smtp",
  "imap",
  "ns",
  "ns1",
  "ns2",
  "mx",
  "autodiscover",
  "autoconfig",
  // `_acme-challenge` — the label the wildcard certificate's DNS-01 challenge
  // is published at — needs no entry: the underscore fails the charset check
  // in validateSubdomain before reservations are consulted.
];

/**
 * A DNS label is not a slug, and the difference matters at exactly the points
 * where a bad value stops being cosmetic:
 *
 *  - 63 characters is the hard limit for one label in DNS, not a style choice.
 *  - 3 characters minimum keeps single-letter hosts (and their typo-squatting
 *    neighbours) out, and leaves room for the operator's own short names.
 *  - A leading or trailing hyphen is illegal in a hostname.
 *  - `xx--` at positions 3-4 is the punycode prefix form (`xn--`); any label
 *    shaped that way is interpreted as an internationalised domain name by
 *    resolvers and certificate authorities, so it is refused rather than
 *    issued and left to fail mysteriously later.
 */
export const MIN_SUBDOMAIN_LENGTH = 3;
export const MAX_SUBDOMAIN_LENGTH = 63;

export type SubdomainError = "invalid_subdomain" | "reserved_subdomain";

/** null when `value` is a usable subdomain; otherwise why it is not. */
export function validateSubdomain(value: string): SubdomainError | null {
  const label = value.trim().toLowerCase();

  if (!/^[a-z0-9-]+$/.test(label)) return "invalid_subdomain";
  if (label.length < MIN_SUBDOMAIN_LENGTH || label.length > MAX_SUBDOMAIN_LENGTH) return "invalid_subdomain";
  if (label.startsWith("-") || label.endsWith("-")) return "invalid_subdomain";
  if (label.slice(2, 4) === "--") return "invalid_subdomain";
  if (RESERVED_SLUGS.includes(label)) return "reserved_subdomain";

  return null;
}

/**
 * A subdomain candidate from a business name: the slug rules, then the label
 * rules on top. Returns "" when nothing usable survives, so the caller decides
 * between a fallback and an error — same contract as slugifyBusinessName.
 */
export function subdomainFromBusinessName(name: string): string {
  const candidate = slugifyBusinessName(name).slice(0, MAX_SUBDOMAIN_LENGTH).replace(/^-+|-+$/g, "");
  return validateSubdomain(candidate) === null ? candidate : "";
}

/**
 * A slug candidate for a business name.
 *
 * Returns "" when the name yields nothing usable, so the caller can decide
 * between a fallback and an error rather than being handed a silent default.
 */
export function slugifyBusinessName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    // Arabic-Indic and Persian digits → ASCII, so "کافه۱" and "کافه1" agree.
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    // Arabic letter variants Persian keyboards produce interchangeably.
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک");

  const slug = transliterate(normalized)
    // Zero-width non-joiner (U+200C, "می‌کنم"-style half-space) is a word separator.
    .replace(/[\s_\u200c]+/g, "-")
    .replace(ALLOWED, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return slug.slice(0, MAX_SLUG_LENGTH).replace(/-$/, "");
}

/**
 * Makes a slug unique against those already taken.
 *
 * Appends -2, -3, … rather than a random suffix so the common case stays
 * readable and the collision case stays predictable. `taken` is checked
 * case-insensitively to match the `citext` column it lands in.
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken, ...RESERVED_SLUGS].map((s) => s.toLowerCase()));
  const stem = (base || SLUG_FALLBACK).slice(0, MAX_SLUG_LENGTH - 4).replace(/-$/, "");

  if (!used.has(stem)) return stem;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${stem}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  // Astronomically unlikely; still better than looping forever.
  return `${stem}-${Date.now().toString(36)}`;
}
