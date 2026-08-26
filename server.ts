/**
 * Custom server (Phase 4): wraps Next.js's request handler with a plain
 * `http.Server` so we can also accept WebSocket upgrades on `/ws` for live
 * sync between the cashier, waiter app, KDS, and floor plan. `npm run build`
 * still uses plain `next build`; only `dev`/`start` go through this file.
 *
 * Other upgrade requests (e.g. Next's dev-mode HMR websocket) are handed off
 * to Next's own upgrade handler so `next dev` keeps working normally.
 */
import { createServer, type IncomingMessage } from "http";
import type { Duplex } from "stream";
import { parse } from "url";
import { WebSocketServer } from "ws";

// `require`, not `import`: Next's own require-hook (which wires up the
// AsyncLocalStorage polyfill app-render needs) only runs on a CJS require of
// the package; importing it as an ESM module under tsx skips that hook and
// crashes on first render ("AsyncLocalStorage accessed in runtime where it
// is not available").
// eslint-disable-next-line @typescript-eslint/no-require-imports
const next = require("next") as typeof import("next").default;

const port = Number(process.env.PORT) || 3000;
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

app.prepare().then(async () => {
  // Loaded dynamically, and only after prepare(): src/lib/auth.ts pulls in
  // next/server + next/headers, and importing those before Next's own
  // server bootstrap has run (inside prepare()) caches a broken internal
  // AsyncLocalStorage stub that then breaks every page render.
  const { SESSION_COOKIE, verifySession } = await import("./src/lib/auth");
  const { registerConnection } = await import("./src/lib/realtime");
  const { runRollupSyncTick } = await import("./src/lib/rollup-service");
  const { ROLLUP_SYNC_INTERVAL_MS } = await import("./src/lib/rollup");
  const { runBackupTick } = await import("./src/lib/backup-service");
  const { BACKUP_TICK_INTERVAL_MS } = await import("./src/lib/backup");
  const { runServerSyncTick, SERVER_SYNC_INTERVAL_MS } = await import("./src/lib/server-sync");
  const { assertRlsEffective } = await import("./src/lib/db");
  const { describeDeploymentRole } = await import("./src/lib/deployment-role");
  const { runAiSubscriptionRenewalTick, AI_SUBSCRIPTION_TICK_INTERVAL_MS } = await import("./src/lib/ai-billing-service");
  const { runAiProactiveTick, AI_PROACTIVE_TICK_INTERVAL_MS } = await import("./src/lib/ai-proactive-service");
  const { runWooCommerceSyncTick, WOO_SYNC_TICK_INTERVAL_MS } = await import("./src/lib/integrations/outbox-service");
  const { runHolooSyncTick, HOLOO_SYNC_TICK_INTERVAL_MS } = await import("./src/lib/integrations/holoo/pull-service");
  const { runHolooPushTick, HOLOO_PUSH_TICK_INTERVAL_MS } = await import("./src/lib/integrations/holoo/push-service");
  const { runNotificationTick, NOTIFICATION_TICK_INTERVAL_MS } = await import("./src/lib/notifications-service");
  const { runLowStockScanTick, LOW_STOCK_SCAN_INTERVAL_MS } = await import("./src/lib/notification-scans");

  // Phase 12: tenant isolation is enforced by Postgres row-level security,
  // which superusers and BYPASSRLS roles ignore outright — silently, with no
  // error to notice. Refuse to serve production traffic in that state; in
  // development this only warns (see assertRlsEffective).
  await assertRlsEffective();

  // Phase 9: push this location's daily rollup to the configured central
  // server. A tick that can't reach central just records the error and the
  // next one retries the widened window — that's the offline catch-up story.
  const rollupTick = () =>
    runRollupSyncTick().catch((err) => console.error("rollup sync tick failed:", err));
  setInterval(rollupTick, ROLLUP_SYNC_INTERVAL_MS).unref();
  setTimeout(rollupTick, 30_000).unref();

  // Phase 10: scheduled backups. The tick just checks whether a schedule
  // slot passed without a run (and re-nudges failed cloud uploads); failures
  // land in backup_runs and surface as the dashboard alert.
  const backupTick = () =>
    runBackupTick().catch((err) => console.error("backup tick failed:", err));
  setInterval(backupTick, BACKUP_TICK_INTERVAL_MS).unref();
  setTimeout(backupTick, 45_000).unref();

  // Phase 11: bidirectional server-to-server sync (café laptop ←→ VPS). Each
  // tick pushes locally-born sync_events to the configured remote and pulls
  // the remote's events back, replaying both through the same idempotent
  // applySyncEvent() engine the client offline-queue uses. A tick that can't
  // reach the remote just records the error; the next tick resumes from the
  // stored high-water mark. Disabled unless a business has configured a
  // server-sync target (settings key server_sync.config).
  const serverSyncTick = () =>
    runServerSyncTick().catch((err) => console.error("server-sync tick failed:", err));
  setInterval(serverSyncTick, SERVER_SYNC_INTERVAL_MS).unref();
  setTimeout(serverSyncTick, 20_000).unref();

  // Phase 18: subscriptions grant their monthly credits in a tenant-scoped
  // transaction. The service discovers due businesses under the documented
  // platform bypass, then re-enters each one with withTenant before writing.
  const aiSubscriptionTick = () =>
    runAiSubscriptionRenewalTick().catch((err) => console.error("AI subscription renewal tick failed:", err));
  setInterval(aiSubscriptionTick, AI_SUBSCRIPTION_TICK_INTERVAL_MS).unref();
  setTimeout(aiSubscriptionTick, 60_000).unref();

  // Phase 18b Wave 4: opt-in proactive AI jobs. The service enumerates
  // businesses only under the documented platform bypass and then wraps each
  // tenant's facts, credit reservation and output rows in withTenant.
  const aiProactiveTick = () =>
    runAiProactiveTick().catch((err) => console.error("proactive AI tick failed:", err));
  setInterval(aiProactiveTick, AI_PROACTIVE_TICK_INTERVAL_MS).unref();
  setTimeout(aiProactiveTick, 75_000).unref();

  // Phase 23 (issue #118): drain the WooCommerce stock/price outbox. The tick
  // enumerates active connections under the documented platform bypass, then
  // wraps each business's diff/push work in withTenant — the same shape as
  // every other background tick here.
  const wooSyncTick = () =>
    runWooCommerceSyncTick().catch((err) => console.error("woocommerce sync tick failed:", err));
  setInterval(wooSyncTick, WOO_SYNC_TICK_INTERVAL_MS).unref();
  setTimeout(wooSyncTick, 90_000).unref();

  // Phase 26 (issue #125) Wave 7: mirror Holoo base data for companion-mode
  // businesses. Polling (Holoo cannot call back), gated on holoo_companion,
  // enumerating under the platform bypass and re-entering each business with
  // withTenant — the same shape as the WooCommerce tick above.
  const holooSyncTick = () =>
    runHolooSyncTick().catch((err) => console.error("holoo sync tick failed:", err));
  setInterval(holooSyncTick, HOLOO_SYNC_TICK_INTERVAL_MS).unref();
  setTimeout(holooSyncTick, 120_000).unref();

  // Phase 26 Wave 8: drain the Holoo push outbox (sales/receipts/purchases)
  // with the same backoff/dead-letter policy, web_service preferred and the
  // guarded direct_sql fallback.
  const holooPushTick = () =>
    runHolooPushTick().catch((err) => console.error("holoo push tick failed:", err));
  setInterval(holooPushTick, HOLOO_PUSH_TICK_INTERVAL_MS).unref();
  setTimeout(holooPushTick, 150_000).unref();

  // Phase 35: drain the notification outbox and push to each recipient's
  // devices. Producers only enqueue — a cashier closing their till must never
  // wait on a push service — so this tick is the only thing that sends. It
  // enumerates businesses with pending rows under the documented platform
  // bypass and wraps each one's fan-out in withTenant, like every tick above.
  // The shortest interval here on purpose: a notification that arrives ten
  // minutes late is one the person has already found out about another way.
  const notificationTick = () =>
    runNotificationTick().catch((err) => console.error("notification tick failed:", err));
  setInterval(notificationTick, NOTIFICATION_TICK_INTERVAL_MS).unref();
  setTimeout(notificationTick, 25_000).unref();

  // Phase 35: the one notification producer that has to scan rather than be
  // told. Stock leaves an item through six different paths, so "is this item
  // below its reorder level" is a property of the level, not of any one of
  // them — see src/lib/notification-scans.ts. Much slower than the delivery
  // tick above because a reorder level is a "order more this week" signal.
  const lowStockScan = () =>
    runLowStockScanTick().catch((err) => console.error("low-stock scan failed:", err));
  setInterval(lowStockScan, LOW_STOCK_SCAN_INTERVAL_MS).unref();
  setTimeout(lowStockScan, 120_000).unref();

  const server = createServer((req, res) => {
    handle(req, res, parse(req.url ?? "/", true));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = parse(req.url ?? "/", true);

    if (pathname !== "/ws") {
      app.getUpgradeHandler()(req, socket, head);
      return;
    }

    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    const session = token ? await verifySession(token) : null;
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      registerConnection(ws, session);
    });
  });

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port} (WebSocket sync on /ws)`);
    // Phase 23 Wave 2: DEPLOYMENT_ROLE defaults by inference when unset, so
    // say out loud what the app decided — an operator otherwise has no way to
    // tell a central server from a site until the sync tab renders the wrong
    // form.
    console.log(describeDeploymentRole());
  });
});
