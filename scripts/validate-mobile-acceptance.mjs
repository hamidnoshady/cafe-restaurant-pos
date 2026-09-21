#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const input = path.resolve(process.argv.find((value) => value.startsWith("--input="))?.slice(8) || "mobile-acceptance-input.json");
const output = path.resolve(process.argv.find((value) => value.startsWith("--output="))?.slice(9) || "mobile-acceptance-evidence.json");
const config = JSON.parse(await fs.readFile(path.resolve("config/mobile-device-acceptance.json"), "utf8"));
const claim = JSON.parse(await fs.readFile(input, "utf8"));
const platform = config.platforms?.[claim.checkId];
if (!platform) throw new Error("checkId must be android-real-device or ios-real-device");
if (!/^https:\/\//.test(claim.evidenceUrl || "")) throw new Error("an HTTPS evidence URL is required");
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(claim.version || "")) throw new Error("a release version is required");
if (!/^[0-9a-f]{40}$/.test(claim.commit || "")) throw new Error("a full release-candidate Git commit SHA is required");
for (const field of ["deviceModel", "osVersion", "browser", "tester"]) {
  if (typeof claim[field] !== "string" || !claim[field].trim()) throw new Error(`${field} is required`);
}
if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(claim.caSha256Fingerprint || "")) {
  throw new Error("caSha256Fingerprint must be the compared 32-byte uppercase colon-delimited SHA-256 fingerprint");
}
const missing = platform.requiredChecks.filter((id) => claim.checks?.[id] !== true);
const extras = Object.keys(claim.checks || {}).filter((id) => !platform.requiredChecks.includes(id));
if (missing.length) throw new Error(`MANUAL ACCEPTANCE REQUIRED: unchecked evidence: ${missing.join(", ")}`);
if (extras.length) throw new Error(`unknown acceptance checks: ${extras.join(", ")}`);

// Never propagate pairing codes, tokens, cookies, passwords or device secrets.
for (const forbidden of ["token", "password", "cookie", "pairingCode", "privateKey", "credential"]) {
  if (Object.prototype.hasOwnProperty.call(claim, forbidden)) throw new Error(`sensitive field is forbidden: ${forbidden}`);
}
const report = {
  schemaVersion: 1,
  checkId: claim.checkId,
  status: "PASS",
  version: claim.version,
  commit: claim.commit,
  executedAt: new Date().toISOString(),
  evidenceUrl: claim.evidenceUrl,
  platform: `${claim.deviceModel} / ${claim.osVersion} / ${claim.browser}`,
  tester: claim.tester,
  caSha256Fingerprint: claim.caSha256Fingerprint,
  checks: platform.requiredChecks,
  scope: "real-device",
};
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`${claim.checkId} real-device evidence passed all ${platform.requiredChecks.length} required checks.`);
