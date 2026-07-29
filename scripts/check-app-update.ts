/**
 * Run inside the app container by the café laptop's Windows launcher
 * (windows/Start-CafePOS.bat), via `docker compose exec`, right before it
 * decides whether to pull a newer image.
 *
 * Prints a simple, easy-to-parse contract to stdout so a .bat file can
 * consume it without any JSON parsing:
 *
 *   NONE                     — no update available, or nothing configured
 *   UPDATE
 *   <imageRef>
 *   <registryToken>
 *
 * All diagnostics go to stderr, matching the convention in
 * derive-runtime-database-url.ts. The registry token is minted fresh on
 * every run (src/lib/app-update.ts) and is never written to disk or reused —
 * the caller must use it immediately for `docker login` and then discard it.
 */
import "dotenv/config";
import { getPool, query, withTenant, withoutTenantScope } from "../src/lib/db";
import { getServerSyncConfig } from "../src/lib/server-sync";
import { currentAppVersion, fetchUpdatePullCredential, refreshAppUpdateStatus } from "../src/lib/app-update";
import { SETTING_KEYS } from "../src/lib/settings";

async function findLocalBusinessId(): Promise<string | null> {
  // A café laptop (docker-compose.local.yml) hosts exactly one business — the
  // one an Owner paired via Settings → همگام‌سازی با سرور راه دور. Same
  // discovery shape as runServerSyncTick's, so it reuses the same
  // already-justified "platform" bypass category (src/lib/db.ts).
  const rows = await withoutTenantScope("platform", async () => {
    const result = await query<{ business_id: string }>(
      `SELECT business_id FROM settings WHERE key = $1 AND location_id IS NULL LIMIT 1`,
      [SETTING_KEYS.serverSyncConfig],
    );
    return result.rows;
  });
  return rows[0]?.business_id ?? null;
}

async function run(): Promise<void> {
  const businessId = await findLocalBusinessId();
  if (!businessId) {
    console.error("check-app-update: no business has server-sync configured — nothing to check against.");
    console.log("NONE");
    return;
  }

  await withTenant(businessId, async () => {
    const config = await getServerSyncConfig(businessId);
    if (!config?.enabled) {
      console.error("check-app-update: server-sync is not enabled for this business.");
      console.log("NONE");
      return;
    }

    // Cheap version comparison first (no GitHub API call) — only mint a
    // real pull credential if there's actually something newer to fetch.
    const status = await refreshAppUpdateStatus(businessId, config);
    if (!status.updateAvailable) {
      console.error(
        `check-app-update: no update available (current=${currentAppVersion()}, latest=${status.latestVersion}, error=${status.error}).`,
      );
      console.log("NONE");
      return;
    }

    const result = await fetchUpdatePullCredential(config);
    if (!result.ok) {
      console.error(`check-app-update: could not fetch an update credential: ${result.error}`);
      console.log("NONE");
      return;
    }

    console.log("UPDATE");
    console.log(result.credential.imageRef);
    console.log(result.credential.registryToken);
  });
}

run()
  .catch((err) => {
    console.error("check-app-update: unexpected error:", err);
    console.log("NONE");
  })
  .finally(async () => {
    await getPool().end();
    process.exit(0);
  });
