// Cafe POS desktop shell — no Docker, no Docker Desktop, no manual setup.
//
// On first launch this:
//   1. Generates and persists a Postgres password + JWT secret (once, into
//      userData/config.json) — nothing for the person installing to type in.
//   2. Initialises a bundled, real PostgreSQL 16 (via `embedded-postgres`,
//      the same major version this app runs everywhere else) into
//      userData/pgdata, and starts it as a plain background process — no
//      container, no Docker daemon.
//   3. Runs the app's real migrations (scripts/migrate.ts, unmodified)
//      against it.
//   4. Starts the app's real server (server.ts, unmodified) as a child
//      process, using Electron's own bundled Node runtime
//      (ELECTRON_RUN_AS_NODE) so no separate Node.js install is needed
//      either.
//   5. Waits for it to answer on localhost, then opens it in a normal
//      window — no browser chrome, no address bar.
//
// Every subsequent launch skips steps 1–2 (the data + secrets already
// exist) and is fast: start Postgres, start the server, open the window.
//
// Auto-update is NOT part of this yet — see docs/standalone-desktop-app.md.
"use strict";

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const { spawn } = require("node:child_process");

/**
 * `embedded-postgres` is a pure ES module ("type": "module"), and this file is
 * CommonJS — a plain require() of it throws ERR_REQUIRE_ESM. It has to be
 * pulled in with a dynamic import() instead, which is why every caller below
 * awaits this rather than using a module-level binding.
 *
 * It also has to load from real disk rather than from inside app.asar: it
 * locates the bundled Postgres binaries relative to its own import.meta.url
 * (see @embedded-postgres/windows-x64), and those are .exe files Windows must
 * be able to execute directly. When packaged, the module is unpacked to
 * app.asar.unpacked/ (via asarUnpack in package.json), and we import it from
 * there explicitly rather than letting module resolution find it in the asar.
 */
let embeddedPostgresModule = null;
async function loadEmbeddedPostgres() {
  if (!embeddedPostgresModule) {
    if (app.isPackaged) {
      const { pathToFileURL } = require("node:url");
      const unpackedModulePath = path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        "embedded-postgres",
        "dist",
        "index.js",
      );
      embeddedPostgresModule = await import(pathToFileURL(unpackedModulePath).href);
    } else {
      embeddedPostgresModule = await import("embedded-postgres");
    }
  }
  return embeddedPostgresModule.default;
}

const PG_PORT = 5544;
const APP_PORT = 3000;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;

/** Where the bundled Next.js app lives — the repo root in dev, resourcesPath/app when packaged. */
function resolveAppDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app");
  return path.join(__dirname, "..");
}

/** Generated once, then reused forever — nothing here is ever typed by a person. */
function loadOrCreateConfig(userDataDir) {
  const configPath = path.join(userDataDir, "config.json");
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
  const config = {
    pgPassword: crypto.randomBytes(32).toString("hex"),
    jwtSecret: crypto.randomBytes(32).toString("hex"),
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  return config;
}

function isDataDirInitialised(dataDir) {
  return fs.existsSync(path.join(dataDir, "PG_VERSION"));
}

async function ensureDatabaseExists(pg, databaseName) {
  const client = pg.getPgClient();
  await client.connect();
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (rows.length === 0) await pg.createDatabase(databaseName);
  } finally {
    await client.end();
  }
}

/** Runs a bundled tsx script using Electron's OWN Node runtime — no separate Node.js install required on the machine at all. */
function runTsxScript(appDir, scriptRelativePath, env) {
  return new Promise((resolve, reject) => {
    const tsxCli = path.join(appDir, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, scriptRelativePath], {
      cwd: appDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
      stdio: "inherit",
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${scriptRelativePath} exited with code ${code}`))));
    child.on("error", reject);
  });
}

/**
 * Same idea, but captures stdout instead of inheriting it — used for
 * scripts/derive-runtime-database-url.ts, which prints its one line of
 * output rather than logging (see that script's own doc comment: "only the
 * final URL goes to stdout ... every diagnostic goes to stderr").
 */
function runTsxScriptCapture(appDir, scriptRelativePath, env) {
  return new Promise((resolve, reject) => {
    const tsxCli = path.join(appDir, "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsxCli, scriptRelativePath], {
      cwd: appDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
      stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("exit", (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${scriptRelativePath} exited with code ${code}`)),
    );
    child.on("error", reject);
  });
}

/** Same idea, but the server never exits on its own — caller keeps the handle to stop it on quit. */
function spawnServer(appDir, env) {
  const tsxCli = path.join(appDir, "node_modules", "tsx", "dist", "cli.mjs");
  return spawn(process.execPath, [tsxCli, "server.ts"], {
    cwd: appDir,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", ...env },
    stdio: "inherit",
  });
}

function waitForServerReady(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() > deadline) return reject(new Error("Server did not become ready in time"));
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

let pgInstance = null;
let serverProcess = null;

async function startBackend() {
  const userDataDir = app.getPath("userData");
  const appDir = resolveAppDir();
  const config = loadOrCreateConfig(userDataDir);

  const dataDir = path.join(userDataDir, "pgdata");
  const firstRun = !isDataDirInitialised(dataDir);

  const EmbeddedPostgres = await loadEmbeddedPostgres();
  pgInstance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: config.pgPassword,
    port: PG_PORT,
    persistent: true,
    // embedded-postgres passes no --encoding to initdb, so a new cluster
    // inherits its encoding from the machine's system locale. On a Persian
    // Windows install that's WIN1256, and every migration containing a
    // non-ASCII character then fails to apply ("character with byte sequence
    // ... in encoding UTF8 has no equivalent in encoding WIN1256"). Forcing
    // UTF8 matches what docker-compose's postgres:16 image gives us
    // everywhere else. Deliberately NOT also passing --locale=C: that would
    // make collation deterministic across machines, but sorts Persian text by
    // raw codepoint rather than alphabetically (قهوه before چای), which is
    // wrong for a Persian-first POS.
    initdbFlags: ["--encoding=UTF8"],
  });

  if (firstRun) await pgInstance.initialise();
  await pgInstance.start();

  const superuserDatabaseUrl = `postgres://postgres:${config.pgPassword}@127.0.0.1:${PG_PORT}/pos`;
  await ensureDatabaseExists(pgInstance, "pos");

  await runTsxScript(appDir, "scripts/migrate.ts", { DATABASE_URL: superuserDatabaseUrl });

  // server.ts refuses to start against a superuser/BYPASSRLS connection —
  // Phase 12's tenant isolation is Postgres row-level security, which a
  // superuser ignores outright (assertRlsEffective, src/lib/db.ts). Docker's
  // entrypoint solves this the same way: derive-runtime-database-url.ts
  // provisions the restricted `pos_app` role from this superuser connection
  // (reusing its password — nothing new to configure) and hands back the
  // connection string the server should actually run with.
  const runtimeDatabaseUrl = await runTsxScriptCapture(appDir, "scripts/derive-runtime-database-url.ts", {
    DATABASE_URL: superuserDatabaseUrl,
  });

  serverProcess = spawnServer(appDir, {
    DATABASE_URL: runtimeDatabaseUrl,
    // pg_dump can't run as that restricted role — RLS refuses its COPYs — so
    // the backup system keeps the superuser connection (src/lib/backup.ts,
    // dumpDatabaseUrl).
    BACKUP_DATABASE_URL: superuserDatabaseUrl,
    JWT_SECRET: config.jwtSecret,
    PORT: String(APP_PORT),
  });

  await waitForServerReady(APP_URL, 60_000);
}

async function stopBackend() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (pgInstance) {
    await pgInstance.stop().catch(() => {});
    pgInstance = null;
  }
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "Cafe POS",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  await win.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  // The backup-destination wizard step calls this through the preload bridge;
  // a browser has no way to return a real filesystem path, so the desktop
  // shell is the only place it can come from.
  ipcMain.handle("pick-folder", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "پوشهٔ پشتیبان‌گیری",
    });
    return canceled ? null : filePaths[0];
  });

  await startBackend();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", async () => {
  await stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  await stopBackend();
});
