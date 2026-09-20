"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

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

const compiledEntries = [
  "bin/server.cjs",
  "bin/migrate.cjs",
  "bin/derive-runtime-database-url.cjs",
];

for (const relative of [
  "package.json",
  "runtime-build.json",
  ...compiledEntries,
  ".next/BUILD_ID",
  ".next/static",
  "public/sw.js",
  "public/offline.html",
  "public/windows/cafe-pos-print-connector.ps1",
  "migrations/0001_foundation.sql",
]) requirePath(relative);

const bundleDependencyUrl = "file:///C:/__desktop_bundle_dependency__.ts";
try {
  // This check runs on Windows in both desktop workflows, where a file URL
  // without a drive letter throws ERR_INVALID_FILE_URL_PATH before migrations.
  fileURLToPath(bundleDependencyUrl);
} catch (error) {
  fail(`compiled import.meta replacement is invalid on ${process.platform}: ${error.message}`);
}
for (const relative of compiledEntries) {
  const compiled = fs.readFileSync(path.join(runtime, relative), "utf8");
  if (!compiled.includes(bundleDependencyUrl)) {
    fail(`${relative} does not use the portable import.meta replacement`);
  }
  if (compiled.includes("file:///__desktop_bundle_dependency__.ts")) {
    fail(`${relative} still contains the Windows-invalid import.meta replacement`);
  }
}

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
