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
  isCaseOnlyRename: (a: string, b: string) => boolean;
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

/**
 * Whether `name` exists as an exactly-cased entry directly inside `dir`.
 * Plain `fs.existsSync(path.join(dir, name))` is NOT a safe way to assert
 * "the legacy `logs` entry is gone" on a case-insensitive, case-preserving
 * filesystem (NTFS): once the migration renames `logs` to `Logs`,
 * `existsSync(".../logs")` is STILL true on Windows — the differently-cased
 * path resolves to the very same, now-renamed entry. `readdirSync` returns
 * the actual on-disk (case-preserved) names, so it is the only reliable way
 * to assert that the legacy lowercase name specifically no longer exists
 * (elsewhere in this file, `root` is a real temp dir on whatever filesystem
 * the test runs on — case-sensitive here in the sandbox, case-insensitive
 * on the `windows-latest` CI runner this migration ships to).
 */
function exactCaseEntryExists(dir: string, name: string): boolean {
  return fs.readdirSync(dir).includes(name);
}

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

/**
 * A minimal in-memory filesystem that emulates NTFS's case-insensitive,
 * case-preserving path lookup — this is what actually caught the CI
 * failure (`unit tests` runs on `windows-latest`; this sandbox's real disk
 * is Linux/case-sensitive and could not reproduce it). Every legacy entry
 * maps 1:1 onto a differently-cased destination except one: legacy `logs`
 * -> new `Logs`, same parent, same name except case. On a real NTFS
 * volume `existsSync("…/Logs")` is true the instant `…/logs` exists — the
 * two paths name the identical on-disk entry — which made the original
 * "does the destination already exist?" conflict check misidentify that
 * one rename as an unrelated pre-existing destination and skip it, so the
 * legacy `logs` folder was silently left in place, un-migrated, on every
 * real Windows install.
 */
function makeCaseInsensitiveFakeFs() {
  const entries = new Map<string, { kind: "file" | "dir"; content?: string }>();
  const key = (p: string) => path.resolve(p).toLowerCase();
  const parentDirsOf = (p: string) => {
    const dirs: string[] = [];
    let current = path.dirname(path.resolve(p));
    for (;;) {
      dirs.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return dirs;
  };
  for (const dir of parentDirsOf(root)) entries.set(key(dir), { kind: "dir" });
  entries.set(key(root), { kind: "dir" });

  return {
    existsSync: (p: string) => entries.has(key(p)),
    mkdirSync: (p: string) => {
      entries.set(key(p), { kind: "dir" });
    },
    writeFileSync: (p: string, content: string) => {
      entries.set(key(p), { kind: "file", content });
    },
    readFileSync: (p: string) => {
      const entry = entries.get(key(p));
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return entry.content ?? "";
    },
    renameSync: (from: string, to: string) => {
      const entry = entries.get(key(from));
      if (!entry) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      entries.delete(key(from));
      entries.set(key(to), entry);
    },
    cpSync: () => {
      throw new Error("cpSync should not be needed for a same-volume case-only rename");
    },
    rmSync: () => {
      throw new Error("rmSync should not be needed for a same-volume case-only rename");
    },
  };
}

describe("migrateLegacyLayout on a case-insensitive filesystem (Windows/NTFS regression)", () => {
  it("actually migrates legacy logs/ into Logs/ rather than treating the identical on-disk entry as an occupied destination", () => {
    const fakeFs = makeCaseInsensitiveFakeFs();
    const legacyLogsPath = path.join(root, "logs");
    fakeFs.mkdirSync(legacyLogsPath);
    fakeFs.writeFileSync(path.join(legacyLogsPath, "desktop.log"), "log line");

    const result = appPaths.migrateLegacyLayout(root, { fs: fakeFs });
    const logsEntry = result.results?.find((entry) => entry.key === "logs");
    // This is the exact assertion that failed in CI before the fix:
    // action came back "skipped_target_exists" instead of "moved".
    expect(logsEntry?.action).toBe("moved");
    expect(result.migrated).toBe(true);

    const paths = appPaths.computePaths(root);
    expect(fakeFs.existsSync(path.join(paths.logsDir, "desktop.log"))).toBe(true);
  });

  // Note: there is deliberately no "an unrelated Logs/ pre-exists with no
  // legacy logs/" case here — on a real case-insensitive, case-preserving
  // filesystem (NTFS) `logs` and `Logs` are the SAME directory entry, so
  // that state cannot occur for this one case-only pair: if anything named
  // `Logs` (in either case) exists at all, `existsSync("…/logs")` is
  // already true too. This is exactly why `isCaseOnlyRename` needs to
  // short-circuit the generic "already occupied" check instead of trying
  // to distinguish the two — on Windows there is nothing to distinguish.
});

describe("isCaseOnlyRename", () => {
  it("is exported and identifies same-path-different-case pairs", () => {
    expect(appPaths.isCaseOnlyRename(path.join(root, "logs"), path.join(root, "Logs"))).toBe(true);
  });

  it("is false for genuinely different paths and for identical paths", () => {
    expect(appPaths.isCaseOnlyRename(path.join(root, "logs"), path.join(root, "Data"))).toBe(false);
    expect(appPaths.isCaseOnlyRename(path.join(root, "logs"), path.join(root, "logs"))).toBe(false);
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
    expect(exactCaseEntryExists(root, "logs")).toBe(false);
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
    expect(exactCaseEntryExists(root, "logs")).toBe(false);
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
