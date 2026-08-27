/**
 * Phase 26 (issue #125) Wave 3 — base-data import CLI.
 *
 * Same dry-run/`--apply` discipline as `scripts/inventory-cutover.ts`: a
 * preview run prints exactly what an apply will do, and an apply commits it.
 * The source is a manifest JSON of already-mapped Holoo domain rows (the shape
 * `import-service.ts` consumes); the Holoo-side fetch (raw SQL → mapped rows)
 * is exercised against a real install, and this script is the deterministic,
 * re-runnable half that the preview/apply logic is verified through.
 *
 * Usage:
 *   npx tsx scripts/holoo-import.ts --business <id> --connection <id> \
 *     --manifest holoo-base.json --dry-run
 *   npx tsx scripts/holoo-import.ts --business <id> --connection <id> \
 *     --manifest holoo-base.json --apply
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { withTenant } from "../src/lib/db";
import { applyBaseImport, previewBaseImport, type BaseImportInput } from "../src/lib/integrations/holoo/import-service";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

export async function main(): Promise<void> {
  const businessId = argument("--business");
  const connectionId = argument("--connection");
  const manifestPath = argument("--manifest");
  if (!businessId || !connectionId) throw new Error("--business <id> and --connection <id> are required");
  if (!manifestPath) throw new Error("--manifest <path> is required");
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun === apply) throw new Error("choose exactly one of --dry-run or --apply");

  const input = JSON.parse(await readFile(manifestPath, "utf8")) as BaseImportInput;

  await withTenant(businessId, async () => {
    if (dryRun) {
      const preview = await previewBaseImport(businessId, connectionId, input);
      process.stdout.write(`${JSON.stringify({ mode: "dry-run", ...preview }, null, 2)}\n`);
      return;
    }
    const summary = await applyBaseImport(businessId, connectionId, input);
    process.stdout.write(`${JSON.stringify({ mode: "apply", ...summary }, null, 2)}\n`);
  });
}

void main().catch((error) => {
  console.error((error as Error).message ?? error);
  process.exitCode = 1;
});
