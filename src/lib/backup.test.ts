import { describe, expect, it } from "vitest";
import {
  backupStaleAfterMs,
  cloudKeyFor,
  computeBackupAlert,
  decryptBackup,
  DEFAULT_BACKUP_CONFIG,
  encryptBackup,
  isBackupDue,
  isBackupStale,
  isEncryptedBackup,
  latestSlotBefore,
  makeArtifactName,
  parseArtifactTimestamp,
  selectPrunable,
  toWallClock,
  validateBackupConfig,
  type BackupAlertInput,
} from "./backup";

const TEHRAN = "Asia/Tehran"; // UTC+03:30 year-round (no DST since 2022)

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalHours: 24,
    anchorTime: "03:30",
    localRetention: 14,
    cloud: { ...DEFAULT_BACKUP_CONFIG.cloud },
    ...overrides,
  };
}

describe("validateBackupConfig", () => {
  it("accepts a minimal local-only config", () => {
    const v = validateBackupConfig(validBody());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.config.enabled).toBe(true);
      expect(v.config.cloud.enabled).toBe(false);
    }
  });

  it("rejects non-objects and bad fields", () => {
    expect(validateBackupConfig(null)).toEqual({ ok: false, error: "not_an_object" });
    expect(validateBackupConfig(validBody({ intervalHours: 5 }))).toEqual({
      ok: false,
      error: "invalid_interval",
    });
    expect(validateBackupConfig(validBody({ anchorTime: "25:00" }))).toEqual({
      ok: false,
      error: "invalid_anchor_time",
    });
    expect(validateBackupConfig(validBody({ localRetention: 0 }))).toEqual({
      ok: false,
      error: "invalid_local_retention",
    });
  });

  it("requires endpoint/bucket/credentials/passphrase when cloud is enabled", () => {
    const cloud = {
      enabled: true,
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "backups",
      prefix: "pos-backups/",
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      passphrase: "correct horse battery",
      retention: 30,
    };
    expect(validateBackupConfig(validBody({ cloud })).ok).toBe(true);
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, endpoint: "ftp://x" } }))).toEqual({
      ok: false,
      error: "invalid_cloud_endpoint",
    });
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, bucket: "" } }))).toEqual({
      ok: false,
      error: "missing_cloud_bucket",
    });
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, secretAccessKey: "" } }))).toEqual({
      ok: false,
      error: "missing_cloud_credentials",
    });
    expect(validateBackupConfig(validBody({ cloud: { ...cloud, passphrase: "short" } }))).toEqual({
      ok: false,
      error: "weak_passphrase",
    });
  });

  it("normalizes cloud prefix and endpoint", () => {
    const v = validateBackupConfig(
      validBody({
        cloud: { ...DEFAULT_BACKUP_CONFIG.cloud, prefix: "my-cafe", endpoint: "https://s3.example.com//" },
      }),
    );
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.config.cloud.prefix).toBe("my-cafe/");
      expect(v.config.cloud.endpoint).toBe("https://s3.example.com");
    }
  });
});

describe("artifact naming", () => {
  it("stamps names in UTC and parses them back", () => {
    const name = makeArtifactName(new Date("2026-07-21T03:30:05.123Z"));
    expect(name).toBe("pos-backup-20260721-033005.dump");
    expect(parseArtifactTimestamp(name)).toBe("2026-07-21T03:30:05Z");
    expect(parseArtifactTimestamp(`${name}.enc`)).toBe("2026-07-21T03:30:05Z");
    expect(parseArtifactTimestamp("pos-backups/pos-backup-20260721-033005.dump.enc")).toBe(
      "2026-07-21T03:30:05Z",
    );
  });

  it("rejects names that aren't artifacts (or fake dates)", () => {
    expect(parseArtifactTimestamp("notes.txt")).toBeNull();
    expect(parseArtifactTimestamp("pos-backup-20261341-033005.dump")).toBeNull();
  });

  it("builds cloud keys under the prefix with .enc", () => {
    expect(cloudKeyFor("pos-backups/", "pos-backup-20260721-033005.dump")).toBe(
      "pos-backups/pos-backup-20260721-033005.dump.enc",
    );
    expect(cloudKeyFor("", "a.dump")).toBe("a.dump.enc");
  });
});

describe("schedule slots (wall clock)", () => {
  it("converts instants to Tehran wall clock (+03:30)", () => {
    expect(toWallClock(new Date("2026-07-21T00:00:00Z"), TEHRAN)).toEqual({
      date: "2026-07-21",
      minutes: 3 * 60 + 30,
    });
    // 21:00Z is already the next Tehran day
    expect(toWallClock(new Date("2026-07-20T21:00:00Z"), TEHRAN)).toEqual({
      date: "2026-07-21",
      minutes: 30,
    });
  });

  it("finds the latest daily slot, wrapping to yesterday before the anchor", () => {
    expect(latestSlotBefore({ date: "2026-07-21", minutes: 240 }, "03:30", 24)).toEqual({
      date: "2026-07-21",
      minutes: 210,
    });
    expect(latestSlotBefore({ date: "2026-07-21", minutes: 180 }, "03:30", 24)).toEqual({
      date: "2026-07-20",
      minutes: 210,
    });
  });

  it("steps sub-daily slots off the anchor", () => {
    // anchor 00:30, every 6h → 00:30 / 06:30 / 12:30 / 18:30
    expect(latestSlotBefore({ date: "2026-07-21", minutes: 13 * 60 }, "00:30", 6)).toEqual({
      date: "2026-07-21",
      minutes: 12 * 60 + 30,
    });
    expect(latestSlotBefore({ date: "2026-07-21", minutes: 10 }, "00:30", 6)).toEqual({
      date: "2026-07-20",
      minutes: 18 * 60 + 30,
    });
  });
});

describe("isBackupDue", () => {
  const config = { enabled: true, anchorTime: "03:30", intervalHours: 24 };

  it("is never due while disabled", () => {
    expect(isBackupDue(null, new Date(), { ...config, enabled: false }, TEHRAN)).toBe(false);
  });

  it("is due immediately when nothing ever ran", () => {
    expect(isBackupDue(null, new Date("2026-07-21T08:00:00Z"), config, TEHRAN)).toBe(true);
  });

  it("is due once a slot passes without a run, and not again after covering it", () => {
    // 00:05Z = 03:35 Tehran, just past today's 03:30 slot
    const now = new Date("2026-07-21T00:05:00Z");
    const beforeSlot = "2026-07-20T23:00:00Z"; // 02:30 Tehran, before the slot
    const afterSlot = "2026-07-21T00:01:00Z"; // 03:31 Tehran, covers the slot
    expect(isBackupDue(beforeSlot, now, config, TEHRAN)).toBe(true);
    expect(isBackupDue(afterSlot, now, config, TEHRAN)).toBe(false);
  });

  it("yesterday's run stays sufficient until today's anchor passes", () => {
    const ranYesterday = "2026-07-20T00:10:00Z"; // 03:40 Tehran on the 20th
    const beforeAnchor = new Date("2026-07-20T22:00:00Z"); // 01:30 Tehran on the 21st
    const afterAnchor = new Date("2026-07-21T00:10:00Z"); // 03:40 Tehran on the 21st
    expect(isBackupDue(ranYesterday, beforeAnchor, config, TEHRAN)).toBe(false);
    expect(isBackupDue(ranYesterday, afterAnchor, config, TEHRAN)).toBe(true);
  });
});

describe("selectPrunable", () => {
  const names = [
    "pos-backup-20260718-033001.dump",
    "pos-backup-20260721-033001.dump",
    "pos-backup-20260719-033001.dump",
    "pos-backup-20260720-033001.dump",
    "notes.txt", // never touched
  ];

  it("keeps the newest N artifacts and never touches foreign files", () => {
    expect(selectPrunable(names, 2).sort()).toEqual([
      "pos-backup-20260718-033001.dump",
      "pos-backup-20260719-033001.dump",
    ]);
    expect(selectPrunable(names, 10)).toEqual([]);
  });

  it("works on prefixed encrypted object keys", () => {
    const keys = [
      "pos-backups/pos-backup-20260720-033001.dump.enc",
      "pos-backups/pos-backup-20260721-033001.dump.enc",
    ];
    expect(selectPrunable(keys, 1)).toEqual(["pos-backups/pos-backup-20260720-033001.dump.enc"]);
  });
});

describe("staleness and alerting", () => {
  const now = new Date("2026-07-21T12:00:00Z");

  it("nightly backups get a 30h window (24h + 6h grace)", () => {
    expect(backupStaleAfterMs(24)).toBe(30 * 60 * 60 * 1000);
    expect(backupStaleAfterMs(1)).toBe(2 * 60 * 60 * 1000); // grace floor: 1h
  });

  it("flags missing or old successes as stale", () => {
    expect(isBackupStale(null, 24, now)).toBe(true);
    expect(isBackupStale("2026-07-20T10:00:00Z", 24, now)).toBe(false); // 26h ago < 30h
    expect(isBackupStale("2026-07-19T10:00:00Z", 24, now)).toBe(true); // 50h ago
  });

  const base: BackupAlertInput = {
    enabled: true,
    cloudEnabled: true,
    intervalHours: 24,
    localLastSuccessAt: "2026-07-21T03:30:00Z",
    localLastError: null,
    cloudLastSuccessAt: "2026-07-21T03:31:00Z",
    cloudLastError: null,
  };

  it("walks the severity ladder", () => {
    expect(computeBackupAlert(base, now)).toEqual({ level: "ok", reason: "ok" });
    expect(computeBackupAlert({ ...base, enabled: false }, now)).toEqual({
      level: "warning",
      reason: "disabled",
    });
    expect(computeBackupAlert({ ...base, localLastError: "pg_dump exited 1" }, now)).toEqual({
      level: "error",
      reason: "local_failed",
    });
    expect(computeBackupAlert({ ...base, localLastSuccessAt: null }, now)).toEqual({
      level: "error",
      reason: "local_stale",
    });
    expect(computeBackupAlert({ ...base, cloudLastError: "unreachable" }, now)).toEqual({
      level: "error",
      reason: "cloud_failed",
    });
    expect(computeBackupAlert({ ...base, cloudLastSuccessAt: null }, now)).toEqual({
      level: "error",
      reason: "cloud_stale",
    });
    // cloud problems don't alert while cloud backup is off
    expect(
      computeBackupAlert({ ...base, cloudEnabled: false, cloudLastSuccessAt: null }, now),
    ).toEqual({ level: "ok", reason: "ok" });
  });
});

describe("cloud artifact encryption", () => {
  const plain = Buffer.from("PGDMP fake dump bytes — پشتیبان آزمایشی", "utf8");

  it("round-trips and marks the format", () => {
    const enc = encryptBackup(plain, "correct horse battery");
    expect(isEncryptedBackup(enc)).toBe(true);
    expect(isEncryptedBackup(plain)).toBe(false);
    expect(decryptBackup(enc, "correct horse battery").equals(plain)).toBe(true);
  });

  it("produces different ciphertext each time (fresh salt/IV)", () => {
    const a = encryptBackup(plain, "pass-phrase-1");
    const b = encryptBackup(plain, "pass-phrase-1");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects a wrong passphrase and any tampering", () => {
    const enc = encryptBackup(plain, "correct horse battery");
    expect(() => decryptBackup(enc, "wrong passphrase")).toThrow(/wrong passphrase|corrupted/);
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 20] ^= 0xff;
    expect(() => decryptBackup(tampered, "correct horse battery")).toThrow();
    expect(() => decryptBackup(plain, "x")).toThrow(/bad magic/);
    expect(() => decryptBackup(enc.subarray(0, 20), "x")).toThrow(/truncated/);
  });
});
