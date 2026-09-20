"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SECRET_PATTERNS = [
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+/gi,
  /(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi,
  /((?:jwt|sync|pairing|api)[_-]?(?:secret|token|code)\s*[:=]\s*)[^\s,;]+/gi,
  /((?:password|passphrase)\s*[:=]\s*)[^\s,;]+/gi,
];

function redact(value) {
  let text = value instanceof Error ? `${value.name}: ${value.message}\n${value.stack || ""}` : String(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "$1[REDACTED]");
  return text;
}

function rotate(logPath, maxBytes, retained) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size < maxBytes) return;
    for (let index = retained - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`;
      const target = `${logPath}.${index + 1}`;
      if (fs.existsSync(source)) fs.renameSync(source, target);
    }
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // Logging must never prevent the application from booting.
  }
}

function createLogger(userDataDir, options = {}) {
  const logDir = path.join(userDataDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "desktop.log");
  const maxBytes = options.maxBytes || 5 * 1024 * 1024;
  const retained = options.retained || 5;

  function write(level, message, details) {
    rotate(logPath, maxBytes, retained);
    const suffix = details === undefined ? "" : ` ${redact(details)}`;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}${suffix}\n`;
    try {
      fs.appendFileSync(logPath, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // There is no safe fallback that should make startup fatal.
    }
    const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "log";
    console[consoleMethod](line.trimEnd());
  }

  return {
    path: logPath,
    dir: logDir,
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
    childOutput: (name, chunk, level = "info") => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) write(level, `${name}: ${line}`);
    },
  };
}

module.exports = { createLogger, redact };
