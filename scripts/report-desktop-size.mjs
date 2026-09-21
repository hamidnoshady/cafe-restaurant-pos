#!/usr/bin/env node
/** Writes a reproducible desktop payload report before or after packaging. */
import { readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputArg = process.argv.find((arg) => arg.startsWith("--output="));
const output = outputArg ? path.resolve(outputArg.slice("--output=".length)) : path.join(root, "desktop-size-report.md");

async function bytes(target) {
  if (!existsSync(target)) return 0;
  const info = await stat(target);
  if (info.isFile()) return info.size;
  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    total += await bytes(path.join(target, entry.name));
  }
  return total;
}

const mib = (value) => `${(value / 1024 / 1024).toFixed(1)} MiB`;

async function largestFiles(target, limit) {
  if (!existsSync(target)) return [];
  const files = [];
  async function walk(current) {
    const info = await stat(current);
    if (info.isFile()) {
      files.push({ path: path.relative(root, current).replaceAll("\\", "/"), bytes: info.size });
      return;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      await walk(path.join(current, entry.name));
    }
  }
  await walk(target);
  return files.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

async function childSizes(target, depth = 2) {
  if (!existsSync(target)) return [];
  const rows = [];
  async function walk(current, remaining) {
    const size = await bytes(current);
    rows.push({ path: path.relative(root, current).replaceAll("\\", "/") || ".", bytes: size });
    if (remaining === 0 || !(await stat(current)).isDirectory()) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(path.join(current, entry.name), remaining - 1);
    }
  }
  await walk(target, depth);
  return rows.sort((a, b) => b.bytes - a.bytes);
}

const targets = [
  ["Next build", ".next"],
  ["Staged desktop runtime", ".desktop-runtime"],
  ["Electron dependencies", "electron/node_modules"],
  ["Embedded PostgreSQL", "electron/node_modules/@embedded-postgres"],
  ["Public assets", "public"],
  ["Migrations", "migrations"],
  ["NSIS installers", "electron/dist"],
  ["win-unpacked", "electron/dist/win-unpacked"],
  ["Packaged resources", "electron/dist/win-unpacked/resources"],
  ["app.asar", "electron/dist/win-unpacked/resources/app.asar"],
  ["app.asar.unpacked", "electron/dist/win-unpacked/resources/app.asar.unpacked"],
  ["PostgreSQL client tools", ".desktop-assets/postgresql-tools"],
  ["Packaged staged runtime", "electron/dist/win-unpacked/resources/desktop-runtime"],
  ["Packaged PostgreSQL client tools", "electron/dist/win-unpacked/resources/postgresql-tools"],
];
const measured = await Promise.all(targets.map(async ([label, relative]) => ({ label, relative, bytes: await bytes(path.join(root, relative)) })));
const roots = [path.join(root, ".desktop-runtime"), path.join(root, "electron", "dist", "win-unpacked")].filter(existsSync);
const dirs = (await Promise.all(roots.map((directory) => childSizes(directory, 3)))).flat().sort((a, b) => b.bytes - a.bytes).slice(0, 50);
const files = (await Promise.all(roots.map((directory) => largestFiles(directory, 100)))).flat().sort((a, b) => b.bytes - a.bytes).slice(0, 100);

const installer = (await readdir(path.join(root, "electron", "dist"), { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".exe"));
for (const entry of installer) measured.push({ label: `Installer ${entry.name}`, relative: `electron/dist/${entry.name}`, bytes: await bytes(path.join(root, "electron", "dist", entry.name)) });

const lines = [
  "# Desktop size report",
  "",
  `Generated: ${new Date().toISOString()}`,
  "",
  "## Summary",
  "",
  "| Item | Path | Size |",
  "|---|---|---:|",
  ...measured.map((row) => `| ${row.label} | \`${row.relative}\` | ${mib(row.bytes)} |`),
  "",
  "## Top 50 directories/packages",
  "",
  ...dirs.map((row, index) => `${index + 1}. \`${row.path}\` — ${mib(row.bytes)}`),
  "",
  "## Top 100 files",
  "",
  ...files.map((row, index) => `${index + 1}. \`${row.path}\` — ${mib(row.bytes)}`),
  "",
];
await writeFile(output, `${lines.join("\n")}\n`);
console.log(`Desktop size report written to ${output}`);
