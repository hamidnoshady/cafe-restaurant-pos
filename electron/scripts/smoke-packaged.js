"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const dist = path.resolve(__dirname, "..", "dist", "win-unpacked");
const executable = path.join(dist, "Business Suite.exe");
if (!fs.existsSync(executable)) throw new Error(`packaged executable is missing: ${executable}`);
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "business-suite-packaged-smoke-"));

function launch(name, bootstrap) {
  const marker = path.join(userData, `${name}.json`);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [`--user-data-dir=${userData}`], {
      env: {
        ...process.env,
        DESKTOP_SMOKE_MARKER: marker,
        DESKTOP_SMOKE_BOOTSTRAP: bootstrap ? "1" : "0",
      },
      windowsHide: true,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      reject(new Error(`${name} packaged launch timed out`));
    }, 180_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${name} packaged launch exited ${code}`));
      if (!fs.existsSync(marker)) return reject(new Error(`${name} did not write its smoke marker`));
      resolve(JSON.parse(fs.readFileSync(marker, "utf8")));
    });
  });
}

(async () => {
  const first = await launch("first-launch", true);
  if (!first.ok || first.needsBootstrap || !first.authenticated || !first.pgdata) {
    throw new Error(`first launch failed acceptance: ${JSON.stringify(first)}`);
  }
  const second = await launch("restart", false);
  if (!second.ok || second.needsBootstrap || !second.pgdata) {
    throw new Error(`restart failed persistence acceptance: ${JSON.stringify(second)}`);
  }
  if (first.instanceId !== second.instanceId) throw new Error("desktop instance identity did not persist across restart");
  if (fs.existsSync(path.join(userData, "pgdata", "postmaster.pid"))) {
    throw new Error("PostgreSQL postmaster.pid remained after clean desktop exit");
  }
  console.log(`Packaged desktop smoke passed. Persistent test data: ${userData}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
