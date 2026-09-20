"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = async function writeSigningStatus(context) {
  const provider = (process.env.WINDOWS_SIGNING_PROVIDER || "unsigned").trim().toLowerCase();
  const output = {
    schemaVersion: 1,
    status: provider === "unsigned" ? "UNSIGNED DEVELOPMENT" : "SIGNED - VERIFICATION REQUIRED",
    provider,
    expectedSigner: process.env.WINDOWS_EXPECTED_SIGNER?.trim() || null,
    rfc3161TimestampRequired: provider !== "unsigned",
    artifact: path.basename(context.artifactPath),
    commit: process.env.GITHUB_SHA || null,
    generatedAt: new Date().toISOString(),
  };
  const destination = path.join(path.dirname(context.artifactPath), "windows-signing-status.json");
  fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
};
