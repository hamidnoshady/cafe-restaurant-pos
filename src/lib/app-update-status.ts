/**
 * Pure decision logic for the app self-update check, split out from
 * app-update.ts (DB- and network-touching, not unit-tested directly per repo
 * convention) the same way server-sync-config.ts holds server-sync.ts's pure
 * config-resolution logic.
 */

/** "unknown" means this image was built with no --build-arg GIT_SHA (e.g. a
 * plain local `docker build`) — nothing meaningful to compare, so never
 * offer an update from it. */
export function computeUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  return latestVersion !== "unknown" && latestVersion !== currentVersion;
}

export function imageRefFor(ghcrImage: string, version: string): string {
  return `${ghcrImage}:sha-${version}`;
}
