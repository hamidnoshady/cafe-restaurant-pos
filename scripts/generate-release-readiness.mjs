#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const arg = (name, fallback) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const configPath = path.resolve(arg("config", "config/release-readiness.json"));
const evidencePath = path.resolve(arg("evidence", "release-evidence.json"));
const outputPath = path.resolve(arg("output", "release-readiness.json"));
const markdownPath = path.resolve(arg("markdown", "release-readiness.md"));
const production = process.argv.includes("--production");
const expectedCommit = arg("commit", process.env.GITHUB_SHA || "");
const expectedVersion = arg("version", "");

const config = JSON.parse(await fs.readFile(configPath, "utf8"));
const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8").catch(() => "{}"));
const expectedInstallerSha256 = arg("installer-sha256", evidence.installerSha256 || "");
if (config.schemaVersion !== 1 || !Array.isArray(config.checks)) throw new Error("invalid readiness configuration");
if (expectedInstallerSha256 && !/^[0-9a-f]{64}$/.test(expectedInstallerSha256)) throw new Error("invalid expected installer SHA-256");

const validClaim = new Set(["PASS", "FAIL"]);
const validEvidenceUrl = (value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};
const validExecutionTime = (value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now() + 5 * 60_000;
};
const results = config.checks.map((check) => {
  const item = evidence.checks?.[check.id];
  let state;
  let reason;
  if (!item || item.configured === false) {
    state = "NOT CONFIGURED";
    reason = item?.reason || "No configured evidence source was supplied.";
  } else if (!validClaim.has(item.status)) {
    state = check.kind === "external" ? "MANUAL ACCEPTANCE REQUIRED" : "FAIL";
    reason = item.reason || "Configured check has no valid PASS/FAIL result.";
  } else if (item.status === "FAIL") {
    state = "FAIL";
    reason = item.reason || "The acceptance check failed.";
  } else if (check.artifactBound === true && !/^[0-9a-f]{64}$/.test(item.installerSha256 || "")) {
    state = check.kind === "external" ? "MANUAL ACCEPTANCE REQUIRED" : "FAIL";
    reason = "Evidence is not bound to an installer SHA-256.";
  } else if (check.artifactBound === true && expectedInstallerSha256 && item.installerSha256 !== expectedInstallerSha256) {
    state = check.kind === "external" ? "MANUAL ACCEPTANCE REQUIRED" : "FAIL";
    reason = `Evidence installer ${item.installerSha256} does not match ${expectedInstallerSha256}.`;
  } else if (!validExecutionTime(item.executedAt) || !validEvidenceUrl(item.evidenceUrl)) {
    state = "FAIL";
    reason = "PASS is invalid without a non-future executedAt value and an HTTPS evidenceUrl.";
  } else if (expectedCommit && item.commit !== expectedCommit) {
    state = check.kind === "external" ? "MANUAL ACCEPTANCE REQUIRED" : "FAIL";
    reason = `Evidence commit ${item.commit || "missing"} does not match ${expectedCommit}.`;
  } else if (expectedVersion && check.versionBound === true && item.version !== expectedVersion) {
    state = check.kind === "external" ? "MANUAL ACCEPTANCE REQUIRED" : "FAIL";
    reason = `Evidence version ${item.version || "missing"} does not match ${expectedVersion}.`;
  } else {
    state = "PASS";
    reason = item.reason || "Acceptance evidence supplied.";
  }
  return {
    id: check.id,
    label: check.label,
    kind: check.kind,
    requiredForProduction: check.requiredForProduction,
    state,
    reason,
    evidenceUrl: item?.evidenceUrl || null,
    executedAt: item?.executedAt || null,
    platform: item?.platform || null,
  };
});

const blockers = results.filter((result) => result.requiredForProduction && result.state !== "PASS");
const report = {
  schemaVersion: 1,
  status: blockers.length === 0 ? "PASS" : "FAIL",
  productionEligible: blockers.length === 0,
  commit: expectedCommit || null,
  version: expectedVersion || null,
  installerSha256: expectedInstallerSha256 || null,
  generatedAt: new Date().toISOString(),
  allowedStates: ["PASS", "FAIL", "NOT CONFIGURED", "MANUAL ACCEPTANCE REQUIRED"],
  checks: results,
  blockers: blockers.map(({ id, state, reason }) => ({ id, state, reason })),
};
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

const rows = results.map((item) => `| ${item.label} | **${item.state}** | ${item.reason.replaceAll("|", "\\|")} | ${item.evidenceUrl ? `[evidence](${item.evidenceUrl})` : "—"} |`);
const markdown = [
  "# Release readiness",
  "",
  `Overall: **${report.status}** — production eligible: **${report.productionEligible ? "yes" : "no"}**`,
  "",
  "| Check | State | Detail | Evidence |",
  "|---|---|---|---|",
  ...rows,
  "",
  blockers.length ? `Production is blocked by: ${blockers.map((item) => `\`${item.id}\``).join(", ")}.` : "All production requirements passed.",
  "",
].join("\n");
await fs.writeFile(markdownPath, markdown);
console.log(`Release readiness: ${report.status}; ${blockers.length} production blocker(s).`);
if (production && blockers.length) process.exitCode = 1;
