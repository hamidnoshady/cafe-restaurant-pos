/**
 * Local Postgres without Docker.
 *
 * Uses the binaries bundled in the `@embedded-postgres/linux-x64` devDependency
 * (a full PostgreSQL installation shipped as an npm package) to initdb and run
 * a server for local development — the same role the docker-compose files play
 * on machines that have Docker. One process, persistent data dir:
 *
 *   node scripts/dev-postgres.mjs            # init + start, stays in foreground
 *   PGPORT=5433 node scripts/dev-postgres.mjs
 *
 * Defaults match .env.example: postgres://pos:pos@localhost:5432/pos
 * Data lives in ~/pgdata (override with PGDATA).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// `pg` is CommonJS; import it via createRequire so the ESM wrapper doesn't
// change its export shape.
const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE = path.join(ROOT, "node_modules", "@embedded-postgres", "linux-x64", "native");

const PGDATA = process.env.PGDATA ?? path.join(process.env.HOME ?? ROOT, "pgdata");
const PORT = Number(process.env.PGPORT ?? "5432");
const DB_USER = process.env.PG_USER ?? "pos";
const DB_PASSWORD = process.env.PG_PASSWORD ?? "pos";
const DB_NAME = process.env.PG_DB ?? "pos";

if (!existsSync(path.join(NATIVE, "bin", "postgres"))) {
  console.error("Postgres binaries not found. Run: npm i -D @embedded-postgres/linux-x64");
  process.exit(1);
}

const env = {
  ...process.env,
  LD_LIBRARY_PATH: `${path.join(NATIVE, "lib")}${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ""}`,
};

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(NATIVE, "bin", bin), args, { env, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited with code ${code}`))));
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

async function main() {
  if (!existsSync(path.join(PGDATA, "PG_VERSION"))) {
    console.log(`initdb → ${PGDATA}`);
    await run("initdb", ["-D", PGDATA, "-U", DB_USER, "--auth=trust", "--encoding=UTF8", "--no-locale"]);
  }

  console.log(`starting postgres on 127.0.0.1:${PORT} (data: ${PGDATA})`);
  const server = spawn(
    path.join(NATIVE, "bin", "postgres"),
    [
      "-D", PGDATA,
      "-p", String(PORT),
      "-c", "listen_addresses=127.0.0.1",
      "-c", `unix_socket_directories=${PGDATA}`,
    ],
    { env, stdio: "inherit" },
  );

  const client = await waitForPostgres();
  try {
    await client.query(`ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD.replace(/'/g, "''")}'`);
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DB_NAME]);
    if (existing.rowCount === 0) await client.query(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await client.end();
  }
  console.log(`ready: postgres://${DB_USER}:***@localhost:${PORT}/${DB_NAME}`);

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
