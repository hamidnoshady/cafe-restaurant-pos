/**
 * Phase 37 — the gateway's database half, against a real Postgres.
 *
 * `ai-gateway.test.ts` covers the pure resolution logic; this covers the parts
 * that only exist once SQL is involved: that the singleton round-trips
 * (including the `jsonb` lists and the null-vs-undefined budget semantics),
 * that a blank master key keeps the stored one, and — the one that matters —
 * that `ai_business_gateway` is genuinely confined to its own business, so one
 * tenant's virtual key can never be read or written through another tenant's
 * session.
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

let gateway: typeof import("../src/lib/ai-gateway-service");
let dbLib: typeof import("../src/lib/db");

/**
 * RLS only binds when the connecting role is neither a superuser nor
 * BYPASSRLS — which the stock `docker-compose.yml` and the CI service both are
 * (`pos` is a superuser), and which is why `tenant-isolation.integration.test.ts`
 * provisions an unprivileged role on purpose. The cross-tenant assertions below
 * are therefore only meaningful when this run happens to be unprivileged;
 * otherwise they are skipped and the generated isolation test, which always
 * runs unprivileged, is what proves the policy.
 */
let rlsActive = false;

const alpha = { businessId: "" };
const beta = { businessId: "" };

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

/** Runs `fn` scoped to a business, the way an authenticated request would be. */
function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

beforeAll(async () => {
  databaseName = `pos_ai_gw_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  gateway = await import("../src/lib/ai-gateway-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  rlsActive = await dbLib.rlsEffective();
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
  await db.query("DELETE FROM ai_business_gateway");
  await db.query("DELETE FROM platform_ai_gateway");
  await db.query("DELETE FROM businesses");
  const rows = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Alpha', $1), ('Beta', $2) RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`, `beta-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = rows.rows[0].id;
  beta.businessId = rows.rows[1].id;
});

describe("the gateway singleton", () => {
  it("returns a switched-off default before anything is stored", async () => {
    const config = await gateway.getAiGatewayConfig();
    expect(config.enabled).toBe(false);
    expect(config.baseUrl).toBe("http://litellm:4000/v1");
    expect(config.fallbackModels).toEqual([]);
  });

  it("round-trips aliases, the failover chain and the published list", async () => {
    const saved = await gateway.saveAiGatewayConfig({
      enabled: true,
      baseUrl: "http://litellm:4000/v1",
      chatModel: "pos-chat",
      embeddingModel: "pos-embed",
      fallbackModels: ["pos-cheap", "pos-last"],
      routingStrategy: "least-busy",
      allowBusinessModels: true,
      publishedModels: ["pos-chat", "pos-fast"],
    });
    expect(saved.enabled).toBe(true);
    expect(saved.chatModel).toBe("pos-chat");
    expect(saved.embeddingModel).toBe("pos-embed");
    expect(saved.fallbackModels).toEqual(["pos-cheap", "pos-last"]);
    expect(saved.routingStrategy).toBe("least-busy");
    expect(saved.publishedModels).toEqual(["pos-chat", "pos-fast"]);

    const reread = await gateway.getAiGatewayConfig();
    expect(reread).toEqual(saved);
  });

  it("keeps the stored master key when the form leaves it blank", async () => {
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", masterKey: "sk-first" });
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", chatModel: "pos-chat" });
    expect((await gateway.getAiGatewayConfig()).masterKey).toBe("sk-first");
  });

  it("never exposes the master key in the public shape", async () => {
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", masterKey: "sk-secret" });
    const pub = gateway.toPublicAiGatewayConfig(await gateway.getAiGatewayConfig());
    expect(pub.hasMasterKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-secret");
  });

  it("distinguishes an omitted budget from an explicitly cleared one", async () => {
    await gateway.saveAiGatewayConfig({
      baseUrl: "http://litellm:4000/v1",
      defaultMaxBudgetUsd: 25,
      defaultTpmLimit: 500_000,
    });
    // Omitted: keep what is stored.
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", chatModel: "pos-chat" });
    expect((await gateway.getAiGatewayConfig()).defaultMaxBudgetUsd).toBe(25);
    // Explicit null: clear it.
    await gateway.saveAiGatewayConfig({ baseUrl: "http://litellm:4000/v1", defaultMaxBudgetUsd: null });
    expect((await gateway.getAiGatewayConfig()).defaultMaxBudgetUsd).toBeNull();
    expect((await gateway.getAiGatewayConfig()).defaultTpmLimit).toBe(500_000);
  });
});

describe("one business's gateway row", () => {
  const config = {
    enabled: true,
    baseUrl: "http://litellm:4000/v1",
    chatModel: "pos-chat",
    embeddingModel: "",
    fallbackModels: [] as string[],
    routingStrategy: "simple-shuffle" as const,
    virtualKeysEnabled: true,
    allowBusinessModels: true,
    publishedModels: ["pos-chat", "pos-fast"],
    defaultMaxBudgetUsd: null,
    defaultBudgetDuration: "30d",
    defaultTpmLimit: null,
    defaultRpmLimit: null,
    masterKey: "sk-master",
  };

  it("starts absent, which means the shared connection is used", async () => {
    expect(await asBusiness(alpha.businessId, () => gateway.getBusinessGateway(alpha.businessId))).toBeNull();
  });

  it("stores a model override only while the platform publishes that model", async () => {
    const row = await asBusiness(alpha.businessId, () =>
      gateway.saveBusinessGateway(alpha.businessId, { modelOverride: "pos-fast" }, config),
    );
    expect(row.modelOverride).toBe("pos-fast");
  });

  it("refuses an override the platform has not published", async () => {
    await expect(
      asBusiness(alpha.businessId, () =>
        gateway.saveBusinessGateway(alpha.businessId, { modelOverride: "gpt-4o" }, config),
      ),
    ).rejects.toThrow("ai_gateway_model_not_published");
  });

  it("refuses any override once the platform switches the choice off", async () => {
    await expect(
      asBusiness(alpha.businessId, () =>
        gateway.saveBusinessGateway(
          alpha.businessId,
          { modelOverride: "pos-fast" },
          { ...config, allowBusinessModels: false },
        ),
      ),
    ).rejects.toThrow("ai_gateway_model_choice_disabled");
  });

  // Skipped on a superuser connection — see `rlsActive` above.
  it.skipIf(!rlsActive)("keeps one business's row out of another business's session", async () => {
    await asBusiness(alpha.businessId, () =>
      gateway.saveBusinessGateway(alpha.businessId, { modelOverride: "pos-fast", tpmLimit: 900 }, config),
    );

    // Beta's session cannot see it, even by asking for it by id.
    expect(await asBusiness(beta.businessId, () => gateway.getBusinessGateway(alpha.businessId))).toBeNull();
    // And cannot write to it: RLS rejects the row rather than silently
    // creating one under the wrong tenant.
    await expect(
      asBusiness(beta.businessId, () =>
        gateway.saveBusinessGateway(alpha.businessId, { modelOverride: "pos-chat" }, config),
      ),
    ).rejects.toThrow();
  });

  it("confines a business's own row to that business, whatever the role", async () => {
    // Holds even on a privileged connection, because the query is written
    // against the caller's own business id rather than trusting RLS alone —
    // defence in depth for the case the policy is somehow not in force.
    await asBusiness(alpha.businessId, () =>
      gateway.saveBusinessGateway(alpha.businessId, { modelOverride: "pos-fast" }, config),
    );
    await asBusiness(beta.businessId, () =>
      gateway.saveBusinessGateway(beta.businessId, { tpmLimit: 1200 }, config),
    );

    const alphaRow = await asBusiness(alpha.businessId, () => gateway.getBusinessGateway(alpha.businessId));
    const betaRow = await asBusiness(beta.businessId, () => gateway.getBusinessGateway(beta.businessId));
    expect(alphaRow?.modelOverride).toBe("pos-fast");
    expect(betaRow?.tpmLimit).toBe(1200);
  });

  it("lists every business's row for the platform console", async () => {
    await asBusiness(alpha.businessId, () =>
      gateway.saveBusinessGateway(alpha.businessId, { modelOverride: "pos-fast" }, config),
    );
    await asBusiness(beta.businessId, () =>
      gateway.saveBusinessGateway(beta.businessId, { tpmLimit: 1200 }, config),
    );

    const rows = await gateway.listBusinessGateways();
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.businessId === alpha.businessId)?.modelOverride).toBe("pos-fast");
    expect(rows.find((row) => row.businessId === beta.businessId)?.tpmLimit).toBe(1200);
  });

  it("reports the model a call would actually use", async () => {
    const row = await asBusiness(alpha.businessId, () =>
      gateway.saveBusinessGateway(alpha.businessId, {}, config),
    );
    expect(gateway.toPublicBusinessGateway(row, config, "gpt-4o-mini").effectiveModel).toBe("pos-chat");

    const overridden = await asBusiness(alpha.businessId, () =>
      gateway.saveBusinessGateway(alpha.businessId, { modelOverride: "pos-fast" }, config),
    );
    expect(gateway.toPublicBusinessGateway(overridden, config, "gpt-4o-mini").effectiveModel).toBe("pos-fast");

    // The virtual key is a bearer credential: it must not be in the shape the
    // console serialises.
    const withKey = { ...overridden, virtualKey: "sk-tenant" };
    const pub = gateway.toPublicBusinessGateway(withKey, config, "gpt-4o-mini");
    expect(pub.hasVirtualKey).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("sk-tenant");
  });
});
