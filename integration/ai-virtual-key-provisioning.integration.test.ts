/**
 * Phase 37 & Phase 39 — the virtual key generator's wire half, against a mock
 * LiteLLM management API and a real Postgres.
 *
 * The console bug this file pins down: minting a key while the gateway is
 * unreachable or misconfigured used to surface as a bare `ai_gateway_*` code
 * on a 502 (or, on the update path, as a green "ذخیره شد" with the failure
 * buried in the row). These tests hold the contract the console now relies on:
 *
 *   - a healthy gateway mints and stores the key;
 *   - a refused mint throws `GatewayProvisioningError` carrying the proxy's
 *     own explanation, so the route can show it;
 *   - a failed re-sync keeps the old key and records the reason on the row;
 *   - an unreachable gateway fails with the `ai_gateway_unreachable` code.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
// Type-only: erased at runtime, so the service (and its db pool) is still
// imported dynamically below, only after DATABASE_URL points at the test db.
import type { GatewayProvisioningError } from "../src/lib/ai-gateway-service";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;

let service: typeof import("../src/lib/ai-gateway-service");
let dbLib: typeof import("../src/lib/db");

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

/** A port nothing listens on, for the unreachable-gateway scenarios. */
const DEAD_GATEWAY_URL = "http://127.0.0.1:9/v1";

let mockGateway: Server;
let mockGatewayUrl = "";
const seenRequests: { method: string; url: string; body: unknown; auth?: string }[] = [];

/** What the mock answers /key/generate with for the *next* request. */
let generateResponse: { status: number; body: unknown } = {
  status: 200,
  body: { key: "sk-minted-123", expires: null },
};

beforeAll(async () => {
  databaseName = `pos_ai_keygen_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  service = await import("../src/lib/ai-gateway-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  mockGateway = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      seenRequests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body,
        auth: req.headers.authorization,
      });
      res.setHeader("content-type", "application/json");
      if (req.url === "/health/liveliness") {
        res.end(JSON.stringify({ status: "healthy" }));
        return;
      }
      if (req.url === "/key/generate") {
        res.statusCode = generateResponse.status;
        res.end(JSON.stringify(generateResponse.body));
        return;
      }
      if (req.url === "/key/update") {
        res.statusCode = generateResponse.status;
        res.end(JSON.stringify(generateResponse.body));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  await new Promise<void>((resolve) => mockGateway.listen(0, "127.0.0.1", resolve));
  const address = mockGateway.address();
  if (address && typeof address === "object") {
    mockGatewayUrl = `http://127.0.0.1:${address.port}/v1`;
  }
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => mockGateway.close(() => resolve()));
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

let businessId: string;

beforeEach(async () => {
  await db.query("DELETE FROM ai_business_gateway");
  await db.query("DELETE FROM platform_ai_gateway");
  await db.query("DELETE FROM businesses");
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Alpha', $1) RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  businessId = biz.rows[0].id;
  seenRequests.length = 0;
  generateResponse = { status: 200, body: { key: "sk-minted-123", expires: null } };
});

async function configuredGateway(overrides: Record<string, unknown> = {}) {
  await service.saveAiGatewayConfig({
    enabled: true,
    baseUrl: mockGatewayUrl,
    masterKey: "sk-master",
    chatModel: "pos-chat",
    ...overrides,
  });
  return service.getAiGatewayConfig();
}

describe("minting a virtual key", () => {
  it("stores the minted key against the business", async () => {
    const config = await configuredGateway();
    const row = await service.provisionVirtualKey(config, { businessId });
    expect(row.virtualKey).toBe("sk-minted-123");
    expect(row.keyAlias).toBeTruthy();
    expect(row.syncError).toBeNull();
    expect(row.syncedAt).toBeTruthy();

    const generate = seenRequests.find((r) => r.url === "/key/generate");
    expect(generate).toBeTruthy();
    expect(generate?.auth).toBe("Bearer sk-master");
    expect((generate?.body as Record<string, unknown>).key_alias).toBe(row.keyAlias);
  });

  it("mints an identity-only key: alias and metadata, nothing else", async () => {
    const config = await configuredGateway();
    const row = await service.provisionVirtualKey(config, { businessId });

    const generate = seenRequests.find((r) => r.url === "/key/generate");
    const body = generate?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["key_alias", "metadata"]);
    // Migration 0168: no models allowlist (changing the platform's chat alias
    // would orphan every existing key) and no mirrored budget or rate limits
    // (the Rial wallet is the single billing stop).
    expect(JSON.stringify(body)).not.toMatch(/"models"|max_budget|budget_duration|tpm_limit|rpm_limit/);
    expect((body.metadata as Record<string, unknown>).business_id).toBe(businessId);
    expect((body.metadata as Record<string, unknown>).source).toBe("cafe-pos");
    expect(JSON.stringify(row)).not.toMatch(/maxBudgetUsd|budgetDuration|tpmLimit|rpmLimit/);
  });

  it("carries the branch id in the alias and metadata for a location key", async () => {
    const config = await configuredGateway();
    const locationId = "9f1c2d3e-4a5b-4067-8089-101112131415";
    await db.query(
      `INSERT INTO locations (id, business_id, name) VALUES ($1, $2, 'شعبهٔ مرکزی')`,
      [locationId, businessId],
    );
    const row = await service.provisionVirtualKey(config, { businessId, locationId });
    // The alias embeds the branch id's first 8 hex chars (see virtualKeyAlias).
    expect(row.keyAlias).toContain("9f1c2d3e");

    const generate = seenRequests.find((r) => r.url === "/key/generate");
    const metadata = (generate?.body as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(metadata.location_id).toBe(locationId);
  });

  it("authenticates the management call with the master key, never a business key", async () => {
    const config = await configuredGateway();
    await service.provisionVirtualKey(config, { businessId });
    expect(seenRequests.at(-1)?.auth).toBe("Bearer sk-master");
  });

  it("carries the proxy's own explanation when the mint is refused", async () => {
    generateResponse = {
      status: 400,
      body: { error: { message: " budgets must be greater than 0" } },
    };
    const config = await configuredGateway();
    const err = await service.provisionVirtualKey(config, { businessId }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(service.GatewayProvisioningError);
    const provisioningError = err as GatewayProvisioningError;
    // The message stays the machine code — the route's contract — while the
    // proxy's explanation rides along for the console.
    expect(provisioningError.message).toBe("ai_gateway_error");
    expect(provisioningError.code).toBe("ai_gateway_error");
    expect(provisioningError.detail).toContain("budgets must be greater than 0");
    // Nothing was stored: a refused mint leaves no row behind.
    expect(await service.getBusinessGateway(businessId)).toBeNull();
  });

  it("fails with the unreachable code when nothing is listening", async () => {
    const config = await configuredGateway({ baseUrl: DEAD_GATEWAY_URL });
    const err = await service.provisionVirtualKey(config, { businessId }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(service.GatewayProvisioningError);
    expect((err as GatewayProvisioningError).code).toBe("ai_gateway_unreachable");
    expect((err as GatewayProvisioningError).message).toBe("ai_gateway_unreachable");
  });

  it("keeps the old key and records the reason when a re-sync is refused", async () => {
    const config = await configuredGateway();
    await service.provisionVirtualKey(config, { businessId });

    // The next sync takes the update path; make the proxy refuse it.
    generateResponse = { status: 401, body: { error: { message: "invalid master key" } } };
    const row = await service.provisionVirtualKey(config, { businessId });
    expect(row.virtualKey).toBe("sk-minted-123");
    expect(row.syncError).toContain("کلید مدیر دروازه پذیرفته نشد");
    expect(row.syncError).toContain("invalid master key");
    const update = seenRequests.find((r) => r.url === "/key/update");
    expect((update?.body as Record<string, unknown>).key).toBe("sk-minted-123");
  });

  it("updates the same key in place instead of minting a second one", async () => {
    const config = await configuredGateway();
    await service.provisionVirtualKey(config, { businessId });
    generateResponse = { status: 200, body: { key: "sk-minted-123", data: {} } };
    const row = await service.provisionVirtualKey(config, { businessId });
    expect(seenRequests.filter((r) => r.url === "/key/generate")).toHaveLength(1);
    expect(seenRequests.filter((r) => r.url === "/key/update")).toHaveLength(1);
    expect(row.virtualKey).toBe("sk-minted-123");
    expect(row.syncError).toBeNull();

    // The update refreshes only the identity metadata — the key keeps
    // whatever the proxy itself enforces on it.
    const update = seenRequests.find((r) => r.url === "/key/update")?.body as Record<string, unknown>;
    expect(Object.keys(update).sort()).toEqual(["key", "key_alias"]);
  });
});
