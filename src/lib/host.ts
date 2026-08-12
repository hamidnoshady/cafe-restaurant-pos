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
 * `pos.eshobe.com`.
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
 * without a valid certificate.
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
 * Whether host-based tenancy is switched on.
 *
 * Off by default and for exactly one release: the path-prefix rewrite stays
 * available until subdomains are proven in production, and a deployment whose
 * DNS or wildcard certificate is not ready yet must not be locked out of its
 * own dashboard by an upgrade. It also needs a ROOT_DOMAIN to be meaningful —
 * `SUBDOMAIN_ROUTING=on` with no root domain would make every host "unknown"
 * and fail every request closed, so that combination reads as off.
 */
export interface HostEnv {
  SUBDOMAIN_ROUTING?: string;
  ROOT_DOMAIN?: string;
}

export function subdomainRoutingEnabled(env: HostEnv): boolean {
  return env.SUBDOMAIN_ROUTING?.trim().toLowerCase() === "on" && Boolean(env.ROOT_DOMAIN?.trim());
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
