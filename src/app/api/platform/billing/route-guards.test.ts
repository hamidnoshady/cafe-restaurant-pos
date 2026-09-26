/**
 * Per-method guard regression for the Billing Control Center's API surface.
 *
 * The sibling `api-guards.test.ts` scan is per-FILE: it passes when any method
 * in the file calls a guard. The plan-features hole this suite pins was
 * exactly that shape — `POST`/`DELETE` carried `requirePlatformCapability`
 * while `GET` relied on `withPlatformScope` alone, which establishes the
 * tenant-scope bypass for the handler but is NOT authentication. An
 * unauthenticated caller could read the whole global pricing catalogue.
 *
 * So this suite scans per-METHOD: every exported handler under
 * src/app/api/platform/billing must run `requirePlatformAdmin` or
 * `requirePlatformCapability` inside its own body (the `withPlatformScope`
 * closure counts as inside — the guard call just has to be in the handler's
 * own text block, not anywhere else in the file).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { describe, expect, it } from "vitest";

const BILLING_API_ROOT = join(process.cwd(), "src", "app", "api", "platform", "billing");

function collectRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectRouteFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

/**
 * Split a route file into its exported handler blocks. Each entry runs from
 * `export const <METHOD> =` up to the next exported method (or EOF), so a
 * guard found in the block is a guard that handler itself runs.
 */
function handlerBlocks(src: string): { method: string; body: string }[] {
  const anchors: { method: string; index: number }[] = [];
  for (const method of METHODS) {
    const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\s*=`, "g");
    for (const m of src.matchAll(re)) anchors.push({ method, index: m.index ?? 0 });
  }
  anchors.sort((a, b) => a.index - b.index);
  return anchors.map((anchor, i) => ({
    method: anchor.method,
    body: src.slice(anchor.index, anchors[i + 1]?.index ?? src.length),
  }));
}

const files = collectRouteFiles(BILLING_API_ROOT);

describe("every billing API method is individually guarded", () => {
  it("found the billing route files (scan is not vacuously green)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const key = relative(BILLING_API_ROOT, dirname(file)).split(sep).join("/");
    const src = readFileSync(file, "utf8");
    const blocks = handlerBlocks(src);

    it(`${key} guards every exported method`, () => {
      expect(blocks.length, `${key} exports no handler methods`).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(
          /requirePlatformAdmin\(|requirePlatformCapability\(/.test(block.body),
          `billing/${key} ${block.method} must call requirePlatformAdmin/requirePlatformCapability inside the handler — withPlatformScope alone is a tenant-scope bypass, not authentication`,
        ).toBe(true);
      }
    });
  }

  it("the historical hole stays closed: plan-features GET authenticates", () => {
    const src = readFileSync(
      join(BILLING_API_ROOT, "plans", "[key]", "features", "route.ts"),
      "utf8",
    );
    const get = handlerBlocks(src).find((b) => b.method === "GET");
    expect(get).toBeDefined();
    expect(/requirePlatformAdmin\(/.test(get!.body)).toBe(true);
  });
});
