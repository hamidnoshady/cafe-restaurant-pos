import { describe, expect, it } from "vitest";
import {
  backupFilename,
  isBackupFilename,
  parseBackupTimestamp,
  selectBackupsToPrune,
} from "./backup";

describe("backupFilename / parseBackupTimestamp", () => {
  it("builds a UTC-stamped filename", () => {
    const d = new Date("2026-07-21T18:30:45Z");
    expect(backupFilename(d)).toBe("pos-backup-20260721-183045.dump");
  });

  it("zero-pads every field", () => {
    const d = new Date("2026-01-02T03:04:05Z");
    expect(backupFilename(d)).toBe("pos-backup-20260102-030405.dump");
  });

  it("round-trips filename → date → filename", () => {
    const d = new Date("2026-11-30T23:59:59Z");
    const name = backupFilename(d);
    const parsed = parseBackupTimestamp(name);
    expect(parsed?.getTime()).toBe(d.getTime());
    expect(backupFilename(parsed!)).toBe(name);
  });

  it("rejects non-backup and malformed names", () => {
    expect(parseBackupTimestamp("notes.txt")).toBeNull();
    expect(parseBackupTimestamp("pos-backup-2026-07-21.dump")).toBeNull();
    expect(parseBackupTimestamp("pos-backup-20260721-183045.sql")).toBeNull();
    expect(parseBackupTimestamp("backup-20260721-183045.dump")).toBeNull();
  });

  it("rejects impossible calendar values", () => {
    expect(parseBackupTimestamp("pos-backup-20261301-000000.dump")).toBeNull(); // month 13
    expect(parseBackupTimestamp("pos-backup-20260732-000000.dump")).toBeNull(); // day 32
    expect(parseBackupTimestamp("pos-backup-20260721-256000.dump")).toBeNull(); // hour 25
  });

  it("isBackupFilename mirrors the parser", () => {
    expect(isBackupFilename("pos-backup-20260721-183045.dump")).toBe(true);
    expect(isBackupFilename("random.dump")).toBe(false);
  });
});

describe("selectBackupsToPrune", () => {
  const names = [
    "pos-backup-20260721-090000.dump",
    "pos-backup-20260720-090000.dump",
    "pos-backup-20260719-090000.dump",
    "pos-backup-20260718-090000.dump",
  ];

  it("keeps the N newest and returns the rest (oldest first)", () => {
    expect(selectBackupsToPrune(names, 2)).toEqual([
      "pos-backup-20260719-090000.dump",
      "pos-backup-20260718-090000.dump",
    ]);
  });

  it("prunes nothing when there are fewer than or equal to keep", () => {
    expect(selectBackupsToPrune(names, 4)).toEqual([]);
    expect(selectBackupsToPrune(names, 10)).toEqual([]);
  });

  it("ignores files that aren't our backups — never deletes them", () => {
    const mixed = [...names, "README.md", "usb-photo.jpg", ".DS_Store"];
    const toPrune = selectBackupsToPrune(mixed, 1);
    expect(toPrune).toEqual([
      "pos-backup-20260720-090000.dump",
      "pos-backup-20260719-090000.dump",
      "pos-backup-20260718-090000.dump",
    ]);
    expect(toPrune).not.toContain("README.md");
    expect(toPrune).not.toContain("usb-photo.jpg");
  });

  it("prunes nothing for a misconfigured (<1) retention, rather than wiping everything", () => {
    expect(selectBackupsToPrune(names, 0)).toEqual([]);
    expect(selectBackupsToPrune(names, -5)).toEqual([]);
  });

  it("orders by embedded timestamp, not array order", () => {
    const shuffled = [names[2], names[0], names[3], names[1]];
    expect(selectBackupsToPrune(shuffled, 1)).toEqual([
      "pos-backup-20260720-090000.dump",
      "pos-backup-20260719-090000.dump",
      "pos-backup-20260718-090000.dump",
    ]);
  });
});
