/**
 * Local Postgres without Docker — Linux, Windows or macOS.
 *
 * Uses the binaries bundled in the `embedded-postgres` devDependency (a full
 * PostgreSQL installation shipped as an npm package) to initdb and run a server
 * for local development — the same role the docker-compose files play on
 * machines that have Docker. One process, persistent data dir:
 *
 *   node scripts/dev-postgres.mjs            # init + start, stays in foreground
 *   PGPORT=5433 node scripts/dev-postgres.mjs
 *
 * CI uses the same script (`npm run db:dev -- --detach`) to provide the
 * database the integration tests need, because a self-hosted Windows runner
 * cannot use GitHub's `services:` containers — those are Linux-container only.
 *
 * Defaults match .env.example: postgres://pos:pos@localhost:5432/pos
 * Data lives in ~/pgdata (override with PGDATA).
 *
 * The platform-specific binaries come from one of the eight
 * `@embedded-postgres/<platform>-<arch>` packages. They are *optional*
 * dependencies of the `embedded-postgres` meta-package, so npm installs only
 * the one matching the current machine and skips the rest — which is what lets
 * a single package-lock.json install cleanly on both the Linux server and the
 * Windows runner. This script resolves whichever one landed rather than naming
 * a platform, so it keeps working on all of them.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// `pg` is CommonJS; import it via createRequire so the ESM wrapper doesn't
// change its export shape.
const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `@embedded-postgres/linux-x64` on Linux, `…/windows-x64` on Windows, and so
 * on. Derived from Node's own platform/arch names, which are exactly the
 * strings those package names use.
 */
const NATIVE_PACKAGE = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const NATIVE = path.join(ROOT, "node_modules", ...NATIVE_PACKAGE.split("/"), "native");

/** Windows ships every Postgres binary as an .exe; POSIX has no suffix. */
const EXE = process.platform === "win32" ? ".exe" : "";
const bin = (name) => path.join(NATIVE, "bin", `${name}${EXE}`);

const PGDATA = process.env.PGDATA ?? path.join(os.homedir() ?? ROOT, "pgdata");
const PORT = Number(process.env.PGPORT ?? "5432");
const DB_USER = process.env.PG_USER ?? "pos";
const DB_PASSWORD = process.env.PG_PASSWORD ?? "pos";
const DB_NAME = process.env.PG_DB ?? "pos";

/**
 * `--detach` starts the server with pg_ctl and returns, instead of holding the
 * foreground. A CI job needs the database to outlive the step that started it;
 * an interactive developer wants Ctrl-C to stop it, which is the default.
 */
const DETACH = process.argv.includes("--detach");
const STOP = process.argv.includes("--stop");

if (!existsSync(bin("postgres"))) {
  console.error(
    `Postgres binaries not found at ${NATIVE}.\n` +
      `Expected the ${NATIVE_PACKAGE} optional dependency to be installed by \`npm ci\`.`,
  );
  process.exit(1);
}

const env = {
  ...process.env,
  // Only POSIX needs the loader pointed at the bundled libs; on Windows the
  // DLLs sit next to the .exe files and are found automatically.
  ...(process.platform === "win32"
    ? {}
    : {
        LD_LIBRARY_PATH: `${path.join(NATIVE, "lib")}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ""}`,
      }),
};

function run(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin(name), args, { env, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited with code ${code}`))));
    child.on("error", reject);
  });
}

async function waitForPostgres() {
  const client = new Client({
    connectionString: `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PORT}/postgres`,
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await client.connect();
      return client;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Postgres did not come up in time.");
}

/**
 * initdb refuses to run as a Windows administrator, and a self-hosted runner
 * installed as a service often *is* one. `--username` + trust auth is already
 * how this script initialises the cluster, so the only extra need is a
 * writable data dir, which %USERPROFILE% always is.
 */
async function initialiseCluster() {
  console.log(`initdb → ${PGDATA}`);
  try {
    await runInitdb();
  } catch (error) {
    if (process.platform === "win32") {
      // PostgreSQL refuses to initialise or run under an account holding
      // administrator rights. A self-hosted GitHub runner installed as a
      // Windows *service* commonly runs as LocalSystem or an admin account,
      // and initdb's own message doesn't say what to change.
      console.error(
        "\ninitdb failed. On Windows, PostgreSQL refuses to run under an account with\n" +
          "administrator rights. If this is a GitHub Actions runner installed as a service,\n" +
          "reconfigure it to run as a normal (non-administrator) user account.\n",
      );
    }
    throw error;
  }
}

function runInitdb() {
  return run("initdb", [
    "-D", PGDATA,
    "-U", DB_USER,
    "--auth=trust",
    // Migrations contain Persian text. Without this a cluster created on a
    // Persian Windows install inherits WIN1256 from the system locale and every
    // non-ASCII migration fails to apply. Matches the postgres:16 image.
    "--encoding=UTF8",
    "--no-locale",
  ]);
}

async function main() {
  if (STOP) {
    await run("pg_ctl", ["-D", PGDATA, "stop", "-m", "fast"]).catch(() => {});
    return;
  }

  if (!existsSync(path.join(PGDATA, "PG_VERSION"))) {
    await initialiseCluster();
  }

  const serverArgs = [
    "-D", PGDATA,
    "-p", String(PORT),
    "-c", "listen_addresses=127.0.0.1",
  ];
  // A Unix socket directory is meaningless on Windows (and pg refuses the
  // flag there); TCP on 127.0.0.1 is what every caller here uses anyway.
  if (process.platform !== "win32") {
    serverArgs.push("-c", `unix_socket_directories=${PGDATA}`);
  }

  console.log(`starting postgres on 127.0.0.1:${PORT} (data: ${PGDATA})`);

  let server = null;
  if (DETACH) {
    // pg_ctl double-forks and writes a pidfile, so the cluster survives this
    // process exiting — which is exactly what a CI step needs.
    const started = spawnSync(
      bin("pg_ctl"),
      ["-D", PGDATA, "-o", serverArgs.slice(2).join(" "), "-l", path.join(PGDATA, "server.log"), "-w", "start"],
      { env, stdio: "inherit" },
    );
    if (started.status !== 0) throw new Error(`pg_ctl start exited with code ${started.status}`);
  } else {
    server = spawn(bin("postgres"), serverArgs, { env, stdio: "inherit" });
  }

  const client = await waitForPostgres();
  try {
    await client.query(`ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD.replace(/'/g, "''")}'`);
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]);
    if (existing.rowCount === 0) await client.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await client.end();
  }
  console.log(`ready: postgres://${DB_USER}:***@localhost:${PORT}/${DB_NAME}`);

  if (DETACH) {
    console.log("running in the background — stop it with: node scripts/dev-postgres.mjs --stop");
    return;
  }

  const stop = () => {
    run("pg_ctl", ["-D", PGDATA, "stop", "-m", "fast"]).catch(() => {});
  };
  process.on("SIGINT", () => {
    stop();
    setTimeout(() => process.exit(0), 2000);
  });
  process.on("SIGTERM", stop);
  server.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
