"use strict";

/**
 * Electron Builder configuration with explicit signing-provider selection.
 * Credentials stay in the provider/environment; this file only wires public
 * account/profile names and enforces that production cannot silently fall back
 * to an unsigned artifact.
 */
const base = require("../package.json").build;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the selected Windows signing provider`);
  return value;
}

const provider = (process.env.WINDOWS_SIGNING_PROVIDER || "unsigned").trim().toLowerCase();
const production = process.env.PRODUCTION_RELEASE === "1";
const expectedSigner = process.env.WINDOWS_EXPECTED_SIGNER?.trim() || "";
const rfc3161 = process.env.WINDOWS_RFC3161_URL?.trim() || "http://timestamp.digicert.com";

if (!new Set(["unsigned", "pfx", "certificate-store", "azure-trusted-signing"]).has(provider)) {
  throw new Error(`Unsupported WINDOWS_SIGNING_PROVIDER: ${provider}`);
}
if (production && provider === "unsigned") {
  throw new Error("Production release is blocked: WINDOWS_SIGNING_PROVIDER is unsigned");
}
if (provider !== "unsigned" && !expectedSigner) {
  throw new Error("WINDOWS_EXPECTED_SIGNER is required for signed builds and post-build verification");
}

const win = {
  ...base.win,
  forceCodeSigning: provider !== "unsigned",
  verifyUpdateCodeSignature: true,
};

if (provider === "pfx") {
  required("CSC_LINK");
  required("CSC_KEY_PASSWORD");
  win.signtoolOptions = {
    signingHashAlgorithms: ["sha256"],
    rfc3161TimeStampServer: rfc3161,
    publisherName: expectedSigner,
  };
} else if (provider === "certificate-store") {
  const subject = process.env.WINDOWS_CERTIFICATE_SUBJECT?.trim();
  const thumbprint = process.env.WINDOWS_CERTIFICATE_SHA1?.trim();
  if (!subject && !thumbprint) throw new Error("certificate-store requires WINDOWS_CERTIFICATE_SUBJECT or WINDOWS_CERTIFICATE_SHA1");
  win.signtoolOptions = {
    signingHashAlgorithms: ["sha256"],
    rfc3161TimeStampServer: rfc3161,
    publisherName: expectedSigner,
    ...(subject ? { certificateSubjectName: subject } : {}),
    ...(thumbprint ? { certificateSha1: thumbprint } : {}),
  };
} else if (provider === "azure-trusted-signing") {
  win.azureSignOptions = {
    endpoint: required("AZURE_TRUSTED_SIGNING_ENDPOINT"),
    codeSigningAccountName: required("AZURE_TRUSTED_SIGNING_ACCOUNT"),
    certificateProfileName: required("AZURE_TRUSTED_SIGNING_PROFILE"),
  };
} else {
  // Do not accidentally discover a developer certificate from the runner.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  console.warn("WINDOWS SIGNING STATUS: UNSIGNED DEVELOPMENT ARTIFACT (not eligible for production release)");
}

module.exports = {
  ...base,
  win,
  artifactBuildCompleted: "scripts/write-signing-status.js",
};
