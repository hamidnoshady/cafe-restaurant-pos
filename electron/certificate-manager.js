"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const forge = require("node-forge");

function pemFingerprint(pem) {
  const der = Buffer.from(pem.replace(/-----(?:BEGIN|END) CERTIFICATE-----|\s/g, ""), "base64");
  return crypto.createHash("sha256").update(der).digest("hex").match(/.{2}/g).join(":").toUpperCase();
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function serial() {
  return crypto.randomBytes(16).toString("hex").replace(/^0+/, "1");
}

function createCertificateManager(userDataDir, logger) {
  const directory = path.join(userDataDir, "gateway-certificates");
  const caKeyPath = path.join(directory, "local-ca-key.pem");
  const caCertPath = path.join(directory, "business-suite-local-ca.crt");
  const leafKeyPath = path.join(directory, "gateway-key.pem");
  const leafCertPath = path.join(directory, "gateway-cert.pem");
  const metadataPath = path.join(directory, "gateway-certificate.json");

  function ensureCa() {
    fs.mkdirSync(directory, { recursive: true });
    if (fs.existsSync(caKeyPath) && fs.existsSync(caCertPath)) {
      return {
        key: forge.pki.privateKeyFromPem(fs.readFileSync(caKeyPath, "utf8")),
        cert: forge.pki.certificateFromPem(fs.readFileSync(caCertPath, "utf8")),
      };
    }
    logger.info("Generating local mobile-access certificate authority");
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 5 * 60_000);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000);
    const attrs = [
      { name: "commonName", value: "Business Suite Local CA" },
      { name: "organizationName", value: "Business Suite Local Installation" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    writePrivate(caKeyPath, forge.pki.privateKeyToPem(keys.privateKey));
    fs.writeFileSync(caCertPath, forge.pki.certificateToPem(cert), { encoding: "utf8", mode: 0o644 });
    return { key: keys.privateKey, cert };
  }

  function ensureLeaf(addresses, force = false) {
    const normalized = [...new Set(addresses)].sort();
    if (!force && fs.existsSync(metadataPath) && fs.existsSync(leafKeyPath) && fs.existsSync(leafCertPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
        if (JSON.stringify(meta.addresses) === JSON.stringify(normalized) && new Date(meta.expiresAt).getTime() > Date.now() + 30 * 24 * 60 * 60_000) {
          return describe(meta);
        }
      } catch {}
    }
    const ca = ensureCa();
    logger.info("Generating HTTPS gateway certificate", { addresses: normalized.join(",") });
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial();
    cert.validity.notBefore = new Date(Date.now() - 5 * 60_000);
    // Apple and Chromium enforce the modern 398-day maximum for publicly
    // trusted-style TLS server leaves even when onboarding a private local CA.
    cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 60 * 60_000);
    cert.setSubject([
      { name: "commonName", value: normalized[0] || "business-suite.local" },
      { name: "organizationName", value: "Business Suite Local Installation" },
    ]);
    cert.setIssuer(ca.cert.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "business-suite.local" },
          ...normalized.map((ip) => ({ type: 7, ip })),
        ],
      },
    ]);
    cert.sign(ca.key, forge.md.sha256.create());
    const certPem = forge.pki.certificateToPem(cert);
    writePrivate(leafKeyPath, forge.pki.privateKeyToPem(keys.privateKey));
    fs.writeFileSync(leafCertPath, certPem, { encoding: "utf8", mode: 0o644 });
    const meta = {
      addresses: normalized,
      generatedAt: new Date().toISOString(),
      expiresAt: cert.validity.notAfter.toISOString(),
      fingerprint: pemFingerprint(certPem),
      caFingerprint: pemFingerprint(fs.readFileSync(caCertPath, "utf8")),
    };
    fs.writeFileSync(metadataPath, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
    return describe(meta);
  }

  function describe(meta = null) {
    if (!meta) {
      if (!fs.existsSync(metadataPath)) return { exists: false, caCertPath };
      meta = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    }
    return { exists: true, ...meta, caCertPath, leafCertPath, leafKeyPath };
  }

  return {
    ensureLeaf,
    regenerate: (addresses) => ensureLeaf(addresses, true),
    describe,
    tlsOptions: () => ({ key: fs.readFileSync(leafKeyPath), cert: fs.readFileSync(leafCertPath) }),
    caCertPath,
  };
}

module.exports = { createCertificateManager, pemFingerprint };
