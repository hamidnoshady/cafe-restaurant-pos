/**
 * Server-only: the fingerprint of the connector payload this deployment
 * ships, baked into generated installers for integrity verification.
 *
 * The canonical payload lives at `public/windows/cafe-pos-print-connector.ps1`
 * and is served statically. Because the same file ships inside every runtime
 * this repo builds (the Docker image copies `public/` in; the desktop runtime
 * verifies it exists), a route handler can read it from disk and answer "if
 * you download the payload from an address this deployment vouches for, this
 * is exactly the SHA-256 you must get". Computing it here — from the bytes
 * actually shipped — means the hash can never drift from the file.
 *
 * Non-fatal by contract: an environment where the file genuinely isn't
 * readable returns null and the installer falls back to its structural
 * checks (marker, HTML rejection, size window, PowerShell parse) rather than
 * refusing to install. Kept in a tiny module of its own so browser-side
 * bundles that import the release constants never pull in `node:fs`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTOR_ASSET_PATH } from "./connector-release";

export interface ConnectorPayloadInfo {
  sha256: string;
  bytes: number;
}

let cached: ConnectorPayloadInfo | null | undefined;

/** Candidate locations of `public/` relative to the running process. */
function candidatePaths(): string[] {
  const relative = CONNECTOR_ASSET_PATH.replace(/^\//, "");
  return [
    join(process.cwd(), "public", relative),
    // A traced Next server runs from .next/standalone with public copied in.
    join(process.cwd(), relative),
  ];
}

export function connectorPayloadInfo(): ConnectorPayloadInfo | null {
  if (cached !== undefined) return cached;
  for (const path of candidatePaths()) {
    try {
      const content = readFileSync(path);
      cached = { sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length };
      return cached;
    } catch {
      // Next candidate.
    }
  }
  cached = null;
  return cached;
}

/** Test hook: recomputing during one process is only ever needed by tests. */
export function resetConnectorPayloadCache(): void {
  cached = undefined;
}
