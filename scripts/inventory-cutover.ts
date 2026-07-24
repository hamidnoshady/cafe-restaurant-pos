import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import {
  applyInventoryCutover,
  dryRunInventoryCutover,
  type InventoryCutoverManifest,
} from "../src/lib/inventory-cutover";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const manifestPath = argument("--manifest");
  if (!manifestPath) throw new Error("--manifest <path> is required");
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");
  if (dryRun === apply) throw new Error("choose exactly one of --dry-run or --apply");

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as InventoryCutoverManifest;
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (dryRun) {
      const result = await dryRunInventoryCutover(client as never, manifest);
      process.stdout.write(`${JSON.stringify({ mode: "dry-run", ...result }, null, 2)}\n`);
      return;
    }
    await client.query("BEGIN");
    try {
      const result = await applyInventoryCutover(client as never, manifest);
      await client.query("COMMIT");
      process.stdout.write(`${JSON.stringify({ mode: "apply", ...result }, null, 2)}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
