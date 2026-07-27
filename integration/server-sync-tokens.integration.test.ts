/**
 * Phase 17 security review: server-sync's receiving side authenticated
 * against one global REMOTE_SYNC_TOKEN env var — fine for a single dedicated
 * VPS, but on a server hosting more than one business it means any one
 * business's café-laptop token also authenticates as every other business
 * hosted there. `server_sync_tokens` (migration 0033) gives each business
 * its own hashed token, resolved before any tenant scope exists (the same
 * category as resolving a login email).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let serverSync: typeof import("../src/lib/server-sync");

const bizA = { id: "" };
const bizB = { id: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_syncauth_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  serverSync = await import("../src/lib/server-sync");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  await db.query("DELETE FROM server_sync_tokens");
  await db.query("DELETE FROM businesses");

  const a = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Cafe A', $1) RETURNING id", [
    `cafe-a-${randomUUID().slice(0, 8)}`,
  ]);
  bizA.id = a.rows[0].id;
  const b = await db.query<{ id: string }>("INSERT INTO businesses (name, slug) VALUES ('Cafe B', $1) RETURNING id", [
    `cafe-b-${randomUUID().slice(0, 8)}`,
  ]);
  bizB.id = b.rows[0].id;

  // setServerSyncConfig's own INSERT relies on ambient tenant scope (RLS's
  // WITH CHECK); these tests call it directly like every other service-layer
  // integration test in this repo, without a session, so scope each call to
  // the business it's configuring.
});

describe("setServerSyncConfig / resolveBusinessBySyncToken", () => {
  it("resolves a configured token to the right business", async () => {
    await dbLib.withTenant(bizA.id, () =>
      serverSync.setServerSyncConfig(bizA.id, { remoteUrl: "https://vps.example.com", token: "token-for-a-1234", enabled: true }),
    );
    expect(await serverSync.resolveBusinessBySyncToken("token-for-a-1234")).toBe(bizA.id);
  });

  it("two businesses' tokens never cross-resolve", async () => {
    await dbLib.withTenant(bizA.id, () =>
      serverSync.setServerSyncConfig(bizA.id, { remoteUrl: "https://vps.example.com", token: "token-for-a-1234", enabled: true }),
    );
    await dbLib.withTenant(bizB.id, () =>
      serverSync.setServerSyncConfig(bizB.id, { remoteUrl: "https://vps.example.com", token: "token-for-b-5678", enabled: true }),
    );

    expect(await serverSync.resolveBusinessBySyncToken("token-for-a-1234")).toBe(bizA.id);
    expect(await serverSync.resolveBusinessBySyncToken("token-for-b-5678")).toBe(bizB.id);
    // Presenting business A's token never resolves to business B, or vice versa.
    expect(await serverSync.resolveBusinessBySyncToken("token-for-a-1234")).not.toBe(bizB.id);
  });

  it("an unconfigured or unknown token resolves to nothing", async () => {
    expect(await serverSync.resolveBusinessBySyncToken("never-configured")).toBeNull();
  });

  it("rotating a business's token invalidates the old one immediately", async () => {
    await dbLib.withTenant(bizA.id, () =>
      serverSync.setServerSyncConfig(bizA.id, { remoteUrl: "https://vps.example.com", token: "old-token-1234", enabled: true }),
    );
    expect(await serverSync.resolveBusinessBySyncToken("old-token-1234")).toBe(bizA.id);

    await dbLib.withTenant(bizA.id, () =>
      serverSync.setServerSyncConfig(bizA.id, { remoteUrl: "https://vps.example.com", token: "new-token-5678", enabled: true }),
    );
    expect(await serverSync.resolveBusinessBySyncToken("old-token-1234")).toBeNull();
    expect(await serverSync.resolveBusinessBySyncToken("new-token-5678")).toBe(bizA.id);
  });

  it("clearing the token (disabling sync) removes resolvability", async () => {
    await dbLib.withTenant(bizA.id, () =>
      serverSync.setServerSyncConfig(bizA.id, { remoteUrl: "https://vps.example.com", token: "token-1234", enabled: true }),
    );
    await dbLib.withTenant(bizA.id, () =>
      serverSync.setServerSyncConfig(bizA.id, { remoteUrl: "", token: "", enabled: false }),
    );
    expect(await serverSync.resolveBusinessBySyncToken("token-1234")).toBeNull();
  });
});

describe("tokensMatch", () => {
  it("matches identical strings and rejects different ones, including different lengths", async () => {
    expect(serverSync.tokensMatch("same-secret", "same-secret")).toBe(true);
    expect(serverSync.tokensMatch("secret-a", "secret-b")).toBe(false);
    expect(serverSync.tokensMatch("short", "a-much-longer-secret-value")).toBe(false);
  });
});
