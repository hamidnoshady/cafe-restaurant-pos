#!/usr/bin/env node
/**
 * Stages the minimal PostgreSQL client payload for Electron packaging.
 *
 * This script performs no network access. A release job supplies an
 * organization-controlled archive, its independently pinned SHA-256, and a
 * provenance allowlist. Only allowlisted files are copied from the archive;
 * every copied file is hashed again and the resulting runtime manifest is what
 * the application verifies before every packaged backup/restore tool use.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, ".desktop-assets", "postgresql-tools");
const required = process.argv.includes("--require");
const archive = process.env.PG_TOOLS_ARCHIVE?.trim();
const manifestPath = process.env.PG_TOOLS_PROVENANCE?.trim();
const pinnedSha256 = process.env.PG_TOOLS_ARTIFACT_SHA256?.trim().toLowerCase();
const SHA = /^[0-9a-f]{64}$/;

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)));
  });
}

function safeRelative(value) {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\\")) return false;
  return path.posix.normalize(value) === value && value !== ".." && !value.startsWith("../");
}

async function markNotConfigured(reason) {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "provenance.json"), `${JSON.stringify({
    schemaVersion: 1,
    status: "not-configured",
    reason,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  if (required) throw new Error(`PostgreSQL tools are required for this build: ${reason}`);
  console.warn(`PostgreSQL tools NOT CONFIGURED (${reason}); development package will expose this state explicitly.`);
}

async function main() {
  if (!archive || !manifestPath || !pinnedSha256) {
    await markNotConfigured("PG_TOOLS_ARCHIVE, PG_TOOLS_PROVENANCE and PG_TOOLS_ARTIFACT_SHA256 must all be supplied");
    return;
  }
  if (!existsSync(archive) || !existsSync(manifestPath)) throw new Error("PostgreSQL tools archive or provenance file does not exist");
  if (!SHA.test(pinnedSha256)) throw new Error("PG_TOOLS_ARTIFACT_SHA256 must be exactly 64 lowercase hex characters");
  const archiveHash = await hashFile(archive);
  if (archiveHash !== pinnedSha256) throw new Error(`PostgreSQL tools archive SHA-256 mismatch: got ${archiveHash}`);

  const supplied = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    supplied.schemaVersion !== 1 ||
    supplied.postgresMajor !== 16 ||
    typeof supplied.postgresVersion !== "string" ||
    !/^16(?:\.\d+){1,2}$/.test(supplied.postgresVersion) ||
    !supplied.artifact || supplied.artifact.sha256 !== pinnedSha256 ||
    typeof supplied.artifact.organization !== "string" || !supplied.artifact.organization.trim() ||
    typeof supplied.artifact.name !== "string" || !supplied.artifact.name.trim() ||
    !Array.isArray(supplied.files)
  ) throw new Error("PostgreSQL tools provenance schema is invalid or does not carry the pinned archive hash");

  const targets = new Set();
  for (const file of supplied.files) {
    if (!safeRelative(file.source) || !safeRelative(file.path) || !file.path.startsWith("bin/") || !SHA.test(file.sha256 ?? "")) {
      throw new Error("PostgreSQL tools provenance contains an unsafe or invalid file entry");
    }
    if (targets.has(file.path)) throw new Error(`duplicate PostgreSQL tools target: ${file.path}`);
    targets.add(file.path);
  }
  for (const executable of ["bin/pg_dump.exe", "bin/pg_restore.exe"]) {
    if (!targets.has(executable)) throw new Error(`PostgreSQL tools provenance omits ${executable}`);
  }

  const temp = await mkdtemp(path.join(os.tmpdir(), "business-suite-pg-tools-"));
  try {
    const listing = String(await run("tar", ["-tf", archive]));
    for (const entry of listing.split(/\r?\n/).filter(Boolean)) {
      const normalized = entry.replaceAll("\\", "/");
      if (path.posix.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
        throw new Error(`unsafe path in PostgreSQL tools archive: ${entry}`);
      }
    }
    await run("tar", ["-xf", archive, "-C", temp]);
    await rm(output, { recursive: true, force: true });
    await mkdir(path.join(output, "bin"), { recursive: true });

    const runtimeFiles = [];
    for (const file of supplied.files) {
      const source = path.resolve(temp, ...file.source.split("/"));
      if (source !== temp && !source.startsWith(`${temp}${path.sep}`)) throw new Error(`source escapes extraction root: ${file.source}`);
      const info = await lstat(source).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`allowlisted PostgreSQL tools file is absent: ${file.source}`);
      const digest = await hashFile(source);
      if (digest !== file.sha256) throw new Error(`PostgreSQL tools file SHA-256 mismatch: ${file.source}`);
      const destination = path.join(output, ...file.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { force: false, errorOnExist: true });
      runtimeFiles.push({ path: file.path, sha256: digest, bytes: (await stat(destination)).size });
    }

    if (process.platform === "win32") {
      for (const tool of ["pg_dump", "pg_restore"]) {
        const version = await run(path.join(output, "bin", `${tool}.exe`), ["--version"]);
        if (!version.includes(supplied.postgresVersion)) throw new Error(`${tool} reports a version different from provenance`);
      }
    }

    const runtimeManifest = {
      schemaVersion: 1,
      status: "verified",
      postgresVersion: supplied.postgresVersion,
      postgresMajor: 16,
      artifact: {
        organization: supplied.artifact.organization,
        name: supplied.artifact.name,
        sha256: pinnedSha256,
        ...(supplied.artifact.sourceBuild ? { sourceBuild: String(supplied.artifact.sourceBuild) } : {}),
      },
      files: runtimeFiles.sort((a, b) => a.path.localeCompare(b.path)),
      generatedAt: new Date().toISOString(),
    };
    await writeFile(path.join(output, "provenance.json"), `${JSON.stringify(runtimeManifest, null, 2)}\n`);
    const bytes = runtimeFiles.reduce((sum, file) => sum + file.bytes, 0);
    console.log(`Staged verified PostgreSQL ${supplied.postgresVersion} client tools (${(bytes / 1024 / 1024).toFixed(1)} MiB).`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch(async (error) => {
  await rm(output, { recursive: true, force: true }).catch(() => {});
  console.error(`PostgreSQL tools staging failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
