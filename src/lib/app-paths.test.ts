/**
 * electron/app-paths.js — the Section 8 desktop-audit fix ("installer
 * should create separate Application/Data/Backup/Logs/Configuration
 * folders"): the canonical Configuration/Data/Backup/Logs layout under one
 * `userData` root, and the one-time migration that moves an existing
 * install's flat layout into it.
 *
 * Real filesystem operations run against a throwaway directory under
 * `os.tmpdir()` (same convention as local-storage.test.ts), since
 * mkdir/rename/rm/cp are all POSIX-portable and this module never touches a
 * Windows-only API. Injected `fs` fakes cover the failure branch (a move
 * that throws) that is impractical to trigger reliably on a real disk.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const appPaths = require("../../electron/app-paths.js") as {
  LEGACY_MIGRATION_MARKER: string;
  computePaths: (userDataDir: string) => Record<string, string>;
  migrationMarkerPath: (userDataDir: string) => string;
  moveEntry: (src: string, dest: string, fsImpl: unknown) => void;
  legacyMoves: (
    userDataDir: string,
    paths: Record<string, string>,
  ) => Array<{ key: string; legacy: string; next: string }>;
  migrateLegacyLayout: (
    userDataDir: string,
    opts?: { fs?: unknown },
  ) => { migrated: boolean; reason?: string; results?: Array<Record<string, unknown>> };
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-pos-app-paths-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("computePaths", () => {
  it("splits userData into Configuration/Data/Backup/Logs", () => {
    const paths = appPaths.computePaths(root);
    expect(paths.configDir).toBe(path.join(root, "Configuration"));
    expect(paths.configPath).toBe(path.join(root, "Configuration", "config.json"));
    expect(paths.dataDir).toBe(path.join(root, "Data"));
    expect(paths.pgDataDir).toBe(path.join(root, "Data", "pgdata"));
    expect(paths.certificatesDir).toBe(path.join(root, "Data", "gateway-certificates"));
    expect(paths.backupDir).toBe(path.join(root, "Backup"));
    expect(paths.emergencyBackupDir).toBe(path.join(root, "Backup", "emergency-backups"));
    expect(paths.logsDir).toBe(path.join(root, "Logs"));
  });

  it("resolves a relative root the same way path.resolve would", () => {
    const relative = appPaths.computePaths("relative-dir");
    expect(relative.root).toBe(path.resolve("relative-dir"));
  });
});

describe("migrateLegacyLayout", () => {
  it("is a no-op on a genuinely fresh install (nothing to move, but still writes the marker)", () => {
    const result = appPaths.migrateLegacyLayout(root);
    expect(result.migrated).toBe(true);
    expect(result.results?.every((entry) => entry.action === "not_present")).toBe(true);
    expect(fs.existsSync(appPaths.migrationMarkerPath(root))).toBe(true);
    // The canonical folders whose destination is nested one level down
    // (Configuration/, Data/, Backup/) exist even though there was nothing
    // to move into them. Logs/ is deliberately NOT pre-created here — its
    // destination IS the top-level folder itself, so pre-creating it would
    // make a real legacy `logs/` migration look like an occupied target
    // (see the dedicated test below); `electron/logger.js` creates it
    // lazily on first use instead, exactly as it always has.
    const paths = appPaths.computePaths(root);
    expect(fs.existsSync(paths.configDir)).toBe(true);
    expect(fs.existsSync(paths.dataDir)).toBe(true);
    expect(fs.existsSync(paths.backupDir)).toBe(true);
  });

  it("moves every legacy flat entry into its new home", () => {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ pgPassword: "secret" }));
    fs.mkdirSync(path.join(root, "pgdata"));
    fs.writeFileSync(path.join(root, "pgdata", "PG_VERSION"), "16");
    fs.mkdirSync(path.join(root, "gateway-certificates"));
    fs.writeFileSync(path.join(root, "gateway-certificates", "gateway-cert.pem"), "cert");
    fs.mkdirSync(path.join(root, "emergency-backups"));
    fs.writeFileSync(path.join(root, "emergency-backups", "pos-emergency-1.dump"), "dump");
    fs.mkdirSync(path.join(root, "logs"));
    fs.writeFileSync(path.join(root, "logs", "desktop.log"), "log line");

    const result = appPaths.migrateLegacyLayout(root);
    expect(result.migrated).toBe(true);
    expect(result.results?.filter((entry) => entry.action === "moved")).toHaveLength(5);

    const paths = appPaths.computePaths(root);
    expect(fs.readFileSync(paths.configPath, "utf8")).toContain("secret");
    expect(fs.existsSync(path.join(paths.pgDataDir, "PG_VERSION"))).toBe(true);
    expect(fs.readFileSync(path.join(paths.certificatesDir, "gateway-cert.pem"), "utf8")).toBe("cert");
    expect(fs.readFileSync(path.join(paths.emergencyBackupDir, "pos-emergency-1.dump"), "utf8")).toBe("dump");
    expect(fs.readFileSync(path.join(paths.logsDir, "desktop.log"), "utf8")).toBe("log line");

    // Legacy locations are gone — nothing left duplicated on disk.
    expect(fs.existsSync(path.join(root, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, "pgdata"))).toBe(false);
    expect(fs.existsSync(path.join(root, "gateway-certificates"))).toBe(false);
    expect(fs.existsSync(path.join(root, "emergency-backups"))).toBe(false);
    expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("never re-runs once the marker exists, even if a legacy folder reappears", () => {
    const first = appPaths.migrateLegacyLayout(root);
    expect(first.migrated).toBe(true);

    // Simulate something recreating a flat config.json after migration
    // (should never happen in practice, but the marker must still win).
    fs.writeFileSync(path.join(root, "config.json"), "should not move");
    const second = appPaths.migrateLegacyLayout(root);
    expect(second.migrated).toBe(false);
    expect(second.reason).toBe("already_migrated");
    const paths = appPaths.computePaths(root);
    expect(fs.existsSync(paths.configPath)).toBe(false);
  });

  it("actually moves legacy logs/ rather than treating the pre-created Logs/ folder as an occupied target (regression)", () => {
    fs.mkdirSync(path.join(root, "logs"));
    fs.writeFileSync(path.join(root, "logs", "desktop.log"), "log line");

    const result = appPaths.migrateLegacyLayout(root);
    const logsEntry = result.results?.find((entry) => entry.key === "logs");
    expect(logsEntry?.action).toBe("moved");
    const paths = appPaths.computePaths(root);
    expect(fs.readFileSync(path.join(paths.logsDir, "desktop.log"), "utf8")).toBe("log line");
    expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
  });

  it("skips a legacy entry instead of overwriting a pre-existing destination", () => {
    fs.writeFileSync(path.join(root, "config.json"), "legacy content");
    const paths = appPaths.computePaths(root);
    fs.mkdirSync(paths.configDir, { recursive: true });
    fs.writeFileSync(paths.configPath, "already there");

    const result = appPaths.migrateLegacyLayout(root);
    const configEntry = result.results?.find((entry) => entry.key === "config");
    expect(configEntry?.action).toBe("skipped_target_exists");
    // Neither copy is destroyed.
    expect(fs.readFileSync(path.join(root, "config.json"), "utf8")).toBe("legacy content");
    expect(fs.readFileSync(paths.configPath, "utf8")).toBe("already there");
    // A skip still counts as a completed pass (not a failure) — the marker is written.
    expect(result.migrated).toBe(true);
    expect(fs.existsSync(appPaths.migrationMarkerPath(root))).toBe(true);
  });

  it("does not write the marker when a move fails, so the migration retries next launch", () => {
    fs.writeFileSync(path.join(root, "config.json"), "legacy content");
    const fakeFs: Record<string, unknown> = {
      ...fs,
      existsSync: fs.existsSync.bind(fs),
      mkdirSync: fs.mkdirSync.bind(fs),
      renameSync: (src: string) => {
        if (src.endsWith("config.json")) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        fs.renameSync(src, src);
      },
      writeFileSync: fs.writeFileSync.bind(fs),
    };
    const result = appPaths.migrateLegacyLayout(root, { fs: fakeFs });
    expect(result.migrated).toBe(false);
    const failed = result.results?.find((entry) => entry.key === "config");
    expect(failed?.action).toBe("failed");
    // The source is untouched — no data lost on a failed move.
    expect(fs.readFileSync(path.join(root, "config.json"), "utf8")).toBe("legacy content");
    expect(fs.existsSync(appPaths.migrationMarkerPath(root))).toBe(false);
  });
});

describe("moveEntry", () => {
  it("falls back to copy+remove on EXDEV rather than failing the whole migration", () => {
    const src = path.join(root, "src-file.txt");
    const dest = path.join(root, "dest-file.txt");
    fs.writeFileSync(src, "cross-device content");
    let renameAttempts = 0;
    const fakeFs = {
      renameSync: () => {
        renameAttempts += 1;
        throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      },
      cpSync: fs.cpSync.bind(fs),
      rmSync: fs.rmSync.bind(fs),
    };
    appPaths.moveEntry(src, dest, fakeFs);
    expect(renameAttempts).toBe(1);
    expect(fs.readFileSync(dest, "utf8")).toBe("cross-device content");
    expect(fs.existsSync(src)).toBe(false);
  });

  it("re-throws a non-EXDEV error rather than silently swallowing it", () => {
    const fakeFs = {
      renameSync: () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    };
    expect(() => appPaths.moveEntry("a", "b", fakeFs)).toThrow("permission denied");
  });
});
