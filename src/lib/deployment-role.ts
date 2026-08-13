/**
 * Which side of the sync link this *install* is: the central server everyone
 * pushes to, or a site (a café laptop, a desktop install) that pushes to one.
 *
 * Deliberately not part of deployment-mode.ts. That answers a different
 * question — how a *business* relates to the platform, written once at first
 * run and stored per business in `settings`. This is a fact about the process
 * and its environment, identical for every business the install serves, and
 * it changes when the deployment changes rather than never.
 *
 * Before this existed, "am I the central server?" was inferred from the mere
 * presence of REMOTE_SYNC_TOKEN, so a VPS rendered a "connect me to a central
 * server" form that made no sense there.
 */

export type DeploymentRole = "central" | "site";

/** Just the variables that bear on the role, so the resolution stays pure. */
export interface DeploymentEnv {
  DEPLOYMENT_ROLE?: string;
  REMOTE_SYNC_TOKEN?: string;
  POS_DOMAIN?: string;
  PLATFORM_BASE_URL?: string;
}

export interface ResolvedDeploymentRole {
  role: DeploymentRole;
  /** Whether DEPLOYMENT_ROLE said so, or we guessed from the rest of the environment. */
  source: "explicit" | "inferred";
}

/**
 * Pure resolution.
 *
 * An unset (or unrecognised) DEPLOYMENT_ROLE infers exactly what the code
 * inferred before this file existed, so no deployment changes behaviour on
 * upgrade: a central server is one that has a REMOTE_SYNC_TOKEN to accept
 * pushes with, or a POS_DOMAIN it serves the platform on. Everything else is
 * a site. An unrecognised value is treated as unset rather than throwing —
 * refusing to boot over a typo'd env var would be a worse failure than
 * falling back to the behaviour the install already had.
 */
export function resolveDeploymentRole(env: DeploymentEnv): ResolvedDeploymentRole {
  const declared = env.DEPLOYMENT_ROLE?.trim().toLowerCase();
  if (declared === "central" || declared === "site") return { role: declared, source: "explicit" };

  const inferred = env.REMOTE_SYNC_TOKEN?.trim() || env.POS_DOMAIN?.trim() ? "central" : "site";
  return { role: inferred, source: "inferred" };
}

/**
 * Pure resolution of the platform's own base URL: PLATFORM_BASE_URL when it
 * is set to something usable, otherwise derived from POS_DOMAIN (which is
 * always served over TLS — it is what Traefik holds the certificate for).
 * Returns null when neither is set, which is the normal state on a site that
 * has not been paired yet.
 */
export function resolvePlatformBaseUrl(env: DeploymentEnv): string | null {
  const explicit = env.PLATFORM_BASE_URL?.trim();
  if (explicit && /^https?:\/\//.test(explicit)) return explicit.replace(/\/+$/, "");

  const domain = env.POS_DOMAIN?.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (domain) return `https://${domain}`;

  return null;
}

// `as DeploymentEnv`: process.env is typed as a bare string index signature
// with no declared properties, so TypeScript's weak-type check rejects the
// assignment for that reason alone even though every read below is safe. The
// alternative — giving DeploymentEnv its own index signature — would cost the
// typo protection the named fields buy in the tests.
export function deploymentRole(): DeploymentRole {
  return resolveDeploymentRole(process.env as DeploymentEnv).role;
}

export function platformBaseUrl(): string | null {
  return resolvePlatformBaseUrl(process.env as DeploymentEnv);
}

/**
 * One line at startup so an operator can see what the app decided, which
 * matters most precisely when nobody set DEPLOYMENT_ROLE and the answer came
 * from inference.
 */
export function describeDeploymentRole(env: DeploymentEnv = process.env as DeploymentEnv): string {
  const { role, source } = resolveDeploymentRole(env);
  const url = resolvePlatformBaseUrl(env);
  return `> deployment role: ${role} (${source})${url ? `, platform ${url}` : ""}`;
}
