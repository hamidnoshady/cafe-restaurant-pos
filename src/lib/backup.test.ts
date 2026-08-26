import { describe, it, expect } from "vitest";
import { cloudKeyFor, selectPrunable, backupPassphrase, type BackupConfig, DEFAULT_BACKUP_CONFIG } from "./backup";

describe("backup", () => {
  it("cloudKeyFor does not double-append .enc", () => {
    expect(cloudKeyFor("pos/", "file.dump")).toBe("pos/file.dump.enc");
    expect(cloudKeyFor("pos/", "file.dump.enc")).toBe("pos/file.dump.enc");
  });

  it("selectPrunable over a mixed .dump/.dump.enc directory", () => {
    const files = [
      "pos-backup-20230101-120000.dump",
      "pos-backup-20230102-120000.dump.enc",
      "pos-backup-20230103-120000.dump",
    ];
    // Keep 2 newest
    const pruned = selectPrunable(files, 2);
    expect(pruned).toEqual(["pos-backup-20230101-120000.dump"]);
  });

  it("backupPassphrase precedence", () => {
    const originalEnv = process.env.BACKUP_PASSPHRASE;

    try {
      process.env.BACKUP_PASSPHRASE = "env-pass";
      
      const conf: BackupConfig = { ...DEFAULT_BACKUP_CONFIG };
      expect(backupPassphrase(conf)).toBe("env-pass");

      conf.cloud = { ...conf.cloud, passphrase: "cloud-pass" };
      expect(backupPassphrase(conf)).toBe("cloud-pass");

      conf.passphrase = "top-pass";
      expect(backupPassphrase(conf)).toBe("top-pass");
    } finally {
      process.env.BACKUP_PASSPHRASE = originalEnv;
    }
  });
});
