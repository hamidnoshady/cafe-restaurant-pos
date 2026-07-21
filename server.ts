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
  });
});
