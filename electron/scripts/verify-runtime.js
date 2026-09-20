"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const runtime = path.join(root, ".desktop-runtime");
const electronPackage = require(path.join(root, "electron", "package.json"));

function fail(message) {
  console.error(`desktop runtime verification failed: ${message}`);
  process.exitCode = 1;
}
function requirePath(relative) {
  if (!fs.existsSync(path.join(runtime, relative))) fail(`missing ${relative}`);
}

for (const relative of [
  "package.json",
  "runtime-build.json",
  "bin/server.cjs",
  "bin/migrate.cjs",
  "bin/derive-runtime-database-url.cjs",
  ".next/BUILD_ID",
  ".next/static",
  "public/sw.js",
  "public/offline.html",
  "public/windows/cafe-pos-print-connector.ps1",
  "migrations/0001_foundation.sql",
]) requirePath(relative);

for (const relative of ["scripts", "next.config.ts", "tsconfig.json", ".next/cache", "coverage", "test-results", ".git"]) {
  if (fs.existsSync(path.join(runtime, relative))) fail(`forbidden staged path ${relative}`);
}
for (const packageName of ["typescript", "tsx", "vitest", "tailwindcss", "@vitest", "@types", "playwright"]) {
  if (fs.existsSync(path.join(runtime, "node_modules", packageName))) fail(`development dependency ${packageName} is staged`);
}

const resources = electronPackage.build.extraResources || [];
if (resources.some((entry) => entry.from === "../node_modules" || entry.to === "app/node_modules")) {
  fail("electron-builder still bulk-copies root node_modules");
}
if (!resources.some((entry) => entry.from === "../.desktop-runtime" && entry.to === "desktop-runtime")) {
  fail("electron-builder does not package the positive runtime stage");
}
const icon = path.resolve(root, "electron", electronPackage.build.win.icon);
if (!fs.existsSync(icon)) fail(`installer icon does not exist: ${icon}`);

const embeddedRoot = path.join(root, "electron", "node_modules", "@embedded-postgres");
const platformPackages = fs.existsSync(embeddedRoot)
  ? fs.readdirSync(embeddedRoot).filter((name) => fs.existsSync(path.join(embeddedRoot, name, "native")))
  : [];
if (process.platform === "win32") {
  if (JSON.stringify(platformPackages) !== JSON.stringify(["windows-x64"])) {
    fail(`expected exactly one Windows PostgreSQL payload, found: ${platformPackages.join(", ") || "none"}`);
  }
} else if (platformPackages.length !== 1) {
  fail(`expected one host PostgreSQL payload, found: ${platformPackages.join(", ") || "none"}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8"));
if (manifest.desktopRuntime?.format !== 1) fail("runtime manifest format is invalid");

if (!process.exitCode) console.log("Desktop runtime shape is valid.");
