/**
 * Which origin a request arrived on: the apex router, the platform console,
 * or one business's own subdomain.
 *
 * Pure and dependency-free because both runtimes need it. `src/middleware.ts`
 * runs on Edge, where it cannot query Postgres — so the *only* thing it can do
 * with a host is parse it and compare the label against the JWT's own claim.
 * The Node-runtime resolver (/api/host/resolve) uses the same parse before it
 * touches the database, so the two layers can never disagree about what a host
 * means.
 *
 * ROOT_DOMAIN drives everything. Locally it is `localtest.me`, which resolves
 * every subdomain to 127.0.0.1 with no hosts-file editing; in production it is
 * whatever zone the deployment was given.
 *
 * The root may itself be a subdomain — `ac.eshobe.com` is a root just as much
 * as `eshobe.com` is, and businesses then live at `biz1.ac.eshobe.com`. Nothing
 * here counts labels in the root: it is matched as a suffix, so one more level
 * of nesting costs nothing in code. What it costs is in DNS and TLS, where the
 * wildcard has to be `*.ac.eshobe.com` — a certificate for `*.eshobe.com` does
 * NOT cover a name one level deeper.
 */

export type HostKind =
  /** The bare root domain — a "which business?" router, authenticates nothing. */
  | "apex"
  /** admin.{root} — the super-admin console's own realm. */
  | "admin"
  /** {label}.{root} — one business's origin. */
  | "business"
  /** Not under ROOT_DOMAIN at all, or ROOT_DOMAIN is unset. */
  | "unknown";

export interface ParsedHost {
  kind: HostKind;
  /** The business label for "business", "admin" for admin, "" otherwise. */
  label: string;
}

/** The console's own host label. Kept here so middleware and slug.ts agree. */
export const ADMIN_HOST_LABEL = "admin";

/**
 * Strips the port and any trailing dot, and lowercases.
 *
 * The Host header carries the port (`acme.localtest.me:3000` in dev, and
 * behind a proxy on any non-standard port), and a fully-qualified name may end
 * in a dot. Neither is part of the name we compare.
 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/**
 * Parses a Host header against ROOT_DOMAIN.
 *
 * Returns "unknown" — never a guess — when the host is not under the root, or
 * when no root is configured. Callers must fail closed on it: an unknown host
 * is precisely the case where we cannot say which tenant is being addressed.
 * Multi-label subdomains (`a.b.{root}`) are also "unknown", because a wildcard
 * certificate covers exactly one level and anything deeper would be served
 * without a valid certificate. This is about labels *below* the root, not the
 * root's own depth: with ROOT_DOMAIN=`ac.eshobe.com`, `biz1.ac.eshobe.com` is
 * one label below the root and resolves normally, while `a.biz1.ac.eshobe.com`
 * does not.
 */
export function parseHost(host: string | null | undefined, rootDomain: string | null | undefined): ParsedHost {
  const root = rootDomain?.trim().toLowerCase().replace(/^\.+|\.+$/g, "") ?? "";
  const name = normalizeHost(host ?? "");
  if (!root || !name) return { kind: "unknown", label: "" };

  if (name === root) return { kind: "apex", label: "" };
  if (!name.endsWith(`.${root}`)) return { kind: "unknown", label: "" };

  const label = name.slice(0, -(root.length + 1));
  if (!label || label.includes(".")) return { kind: "unknown", label: "" };
  if (label === ADMIN_HOST_LABEL) return { kind: "admin", label };

  return { kind: "business", label };
}

/** `{label}.{root}` — for redirects to a business's own origin. */
export function businessHost(label: string, rootDomain: string): string {
  return `${label}.${rootDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "")}`;
}

/**
 * Rewrite the label of an incoming Host header, keeping its port.
 *
 * The port is the point. A redirect built by mutating `request.nextUrl` keeps
 * *that* URL's port — which behind a TLS-terminating proxy is the container's
 * internal one, not the port the browser is talking to. Traefik listens on 443
 * and forwards to 3000, so `/platform` on a tenant host redirected to
 * `https://admin.example.com:3000/platform`, where nothing is listening.
 *
 * The Host header is the right source because it is what the *client* asked
 * for: it carries the external port when there is a non-default one, and none
 * when there isn't.
 */
export function swapHostLabel(hostHeader: string | null | undefined, newLabel: string, rootDomain: string): string {
  const port = (hostHeader ?? "").trim().match(/:(\d+)$/)?.[1];
  return businessHost(newLabel, rootDomain) + (port ? `:${port}` : "");
}

/**
 * The scheme the browser is actually using.
 *
 * `x-forwarded-proto` is what a terminating proxy sets; `fallback` is the
 * request's own scheme, which is correct when nothing is in front. Anything
 * other than http/https in the header is ignored rather than trusted — it is
 * client-supplied unless a proxy overwrote it.
 */
export function preferredProto(forwardedProto: string | null | undefined, fallback: string): string {
  const declared = forwardedProto?.split(",")[0]?.trim().toLowerCase();
  if (declared === "https" || declared === "http") return declared;
  return fallback.replace(/:$/, "") || "https";
}

/**
 * Whether host-based tenancy is switched on.
 *
 * **ROOT_DOMAIN is the switch now.** Phase 23 shipped this behind an opt-in
 * `SUBDOMAIN_ROUTING=on` because the path-prefix rewrite was still the shipped
 * default and had to stay reachable. That rewrite is gone — a business is
 * addressed by its origin and by nothing else — so a deployment that declares
 * a root domain wants per-business origins by definition, and requiring a
 * second variable to say so only produces the failure mode where ROOT_DOMAIN
 * is set, routing is off, and several tenants share one origin with no
 * boundary at all.
 *
 * An install with no ROOT_DOMAIN (the desktop app, a single-café laptop) is
 * unaffected: nothing is host-scoped there, and `/dashboard` is served as-is.
 *
 * `SUBDOMAIN_ROUTING=off` remains as an explicit escape hatch for the one case
 * that still needs it — a deployment whose DNS or wildcard certificate is not
 * ready, which would otherwise be locked out of its own dashboard by an
 * upgrade. Any other value, including unset, means on.
 */
export interface HostEnv {
  SUBDOMAIN_ROUTING?: string;
  ROOT_DOMAIN?: string;
}

/** The values that turn the switch off; everything else (including unset) is on. */
const ROUTING_OFF = new Set(["off", "false", "0", "no"]);

export function subdomainRoutingEnabled(env: HostEnv): boolean {
  if (!env.ROOT_DOMAIN?.trim()) return false;
  return !ROUTING_OFF.has(env.SUBDOMAIN_ROUTING?.trim().toLowerCase() ?? "");
}

/**
 * The same question against the ambient environment, which is how every
 * caller outside the tests asks it.
 *
 * The cast is needed because process.env's type declares no properties of its
 * own, so TypeScript's weak-type check rejects passing it to an all-optional
 * interface — the same reason deployment-role.ts casts.
 */
export function hostRoutingEnabled(): boolean {
  return subdomainRoutingEnabled(process.env as HostEnv);
}

/** ROOT_DOMAIN, trimmed — "" when unset. */
export function rootDomain(): string {
  return process.env.ROOT_DOMAIN?.trim() ?? "";
}
