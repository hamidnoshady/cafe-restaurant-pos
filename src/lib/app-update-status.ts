/** Pure decision logic for manual desktop release-version visibility. */

/** "unknown" means this image was built with no --build-arg GIT_SHA (e.g. a
 * plain local `docker build`) — nothing meaningful to compare, so never
 * offer an update from it. */
export function computeUpdateAvailable(currentVersion: string, latestVersion: string): boolean {
  return latestVersion !== "unknown" && latestVersion !== currentVersion;
}
