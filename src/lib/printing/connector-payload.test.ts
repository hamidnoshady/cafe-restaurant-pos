import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectorPayloadInfo } from "./connector-payload";

describe("connectorPayloadInfo", () => {
  it("fingerprints the connector payload this deployment actually ships", () => {
    // The honest guarantee behind the installer's hash pin: the fingerprint
    // is computed from the shipped file at runtime, so it can never drift
    // from the content the download URL serves.
    const onDisk = readFileSync(join(process.cwd(), "public", "windows", "cafe-pos-print-connector.ps1"));
    const expected = createHash("sha256").update(onDisk).digest("hex");

    const info = connectorPayloadInfo();
    expect(info).not.toBeNull();
    expect(info?.sha256).toBe(expected);
    expect(info?.bytes).toBe(onDisk.length);
  });
});
