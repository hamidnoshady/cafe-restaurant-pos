/**
 * Mints short-lived GitHub App installation tokens scoped to read-only
 * package access, for the app self-update feature (see app-update.ts).
 *
 * Why a GitHub App and not a personal access token: a PAT is a static
 * credential — anything that reveals it holds the same access until someone
 * manually rotates it. An installation token expires on its own (~1h,
 * GitHub-controlled) and is minted fresh per request, so nothing durable
 * ever leaves this server. Only the App's private key is a long-lived
 * secret, and it never leaves the VPS's own environment.
 *
 * One-time setup this depends on (done once, by a human, in GitHub's UI —
 * there is no API for registering a GitHub App): create a GitHub App with
 * "Packages: Read-only" repository permission, install it on this repo, and
 * set GHCR_APP_ID / GHCR_APP_INSTALLATION_ID / GHCR_APP_PRIVATE_KEY on the
 * VPS. See docs/server-sync.md "Self-update".
 */
import { SignJWT, importPKCS8 } from "jose";

interface GithubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPem: string;
}

function readConfig(): GithubAppConfig | null {
  const appId = process.env.GHCR_APP_ID?.trim();
  const installationId = process.env.GHCR_APP_INSTALLATION_ID?.trim();
  // Most secret managers (Komodo included) don't store real newlines, so the
  // PEM is usually pasted with literal "\n" sequences — turn them back into
  // actual newlines, which is a no-op for a key that already has real ones.
  const privateKeyPem = process.env.GHCR_APP_PRIVATE_KEY?.trim().replace(/\\n/g, "\n");
  if (!appId || !installationId || !privateKeyPem) return null;
  return { appId, installationId, privateKeyPem };
}

export function isGithubAppConfigured(): boolean {
  return readConfig() !== null;
}

async function mintAppJwt(config: GithubAppConfig): Promise<string> {
  const key = await importPKCS8(config.privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60) // GitHub allows up to 60s of clock drift
    .setExpirationTime(now + 9 * 60) // GitHub's hard ceiling is 10 minutes
    .setIssuer(config.appId)
    .sign(key);
}

export interface InstallationToken {
  token: string;
  /** ISO timestamp, set by GitHub — always within the next hour. */
  expiresAt: string;
}

/**
 * Mints a fresh installation token, explicitly re-scoped to read-only
 * packages regardless of what the installation is otherwise granted —
 * defense in depth beyond the App's own permission configuration. Never
 * cached: every call hits GitHub, and the result is meant to be handed to
 * exactly one caller for one immediate `docker login`, never stored.
 */
export async function mintPackageReadToken(): Promise<InstallationToken | null> {
  const config = readConfig();
  if (!config) return null;

  let appJwt: string;
  try {
    appJwt = await mintAppJwt(config);
  } catch (err) {
    console.error("github-app-token: failed to sign app JWT:", err);
    return null;
  }

  try {
    const res = await fetch(`https://api.github.com/app/installations/${config.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ permissions: { packages: "read" } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`github-app-token: GitHub rejected the token request: HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    return { token: body.token, expiresAt: body.expires_at };
  } catch (err) {
    console.error("github-app-token: request to GitHub failed:", err);
    return null;
  }
}
