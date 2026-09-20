/**
 * Phase F, Part 5 — a project's default agent, against a real database.
 *
 * The behaviour under test:
 *   - a project can pin an enabled custom agent, read it back, and clear it;
 *   - pinning a disabled or cross-tenant agent is refused (not silently null);
 *   - deleting the pinned agent nulls the pin (ON DELETE SET NULL) rather than
 *     orphaning or breaking the project;
 *   - getProjectPromptContext carries the pin so the chat route can run the turn
 *     as that agent in the same pass it loads instruction/notes/memory/tasks.
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
let projects: typeof import("../src/lib/ai-projects");
let agentsSvc: typeof import("../src/lib/ai-custom-agents-service");

const alpha = { businessId: "", userId: "", projectId: "" };

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
  databaseName = `pos_ai_projagent_${randomUUID().replaceAll("-", "")}`;

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
  projects = await import("../src/lib/ai-projects");
  agentsSvc = await import("../src/lib/ai-custom-agents-service");

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

async function seedBusiness(name: string, slug: string) {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = biz.rows[0].id;
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [businessId, `owner-${slug}@example.test`],
  );
  return { businessId, userId: user.rows[0].id };
}

async function seedAgent(businessId: string, name: string, enabled = true): Promise<string> {
  const created = await dbLib.withTenant(businessId, () =>
    agentsSvc.createCustomAgent(businessId, { name, instructions: "", toolAllowlist: [], actionAllowlist: [] }, null),
  );
  if (!created.ok) throw new Error(`agent seed failed: ${created.errors.join(",")}`);
  if (!enabled) {
    await dbLib.withTenant(businessId, () =>
      agentsSvc.updateCustomAgent(businessId, created.agent.id, { name, enabled: false }),
    );
  }
  return created.agent.id;
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`));

  const project = await dbLib.withTenant(alpha.businessId, () =>
    projects.createProject(
      { businessId: alpha.businessId, actorUserId: alpha.userId },
      { name: "کمپین بهار", instructions: "" },
    ),
  );
  alpha.projectId = project.id;
});

function owner() {
  return { businessId: alpha.businessId, actorUserId: alpha.userId, projectId: alpha.projectId };
}

describe("pinning and clearing", () => {
  it("defaults to no pinned agent", async () => {
    const project = await dbLib.withTenant(alpha.businessId, () => projects.getProject(owner()));
    expect(project?.defaultAgentId).toBeNull();
  });

  it("pins an enabled agent, reads it back, and clears it", async () => {
    const agentId = await seedAgent(alpha.businessId, "بازاریابی");

    const pinned = await dbLib.withTenant(alpha.businessId, () =>
      projects.updateProject(owner(), { defaultAgentId: agentId }),
    );
    expect(pinned?.defaultAgentId).toBe(agentId);

    const readBack = await dbLib.withTenant(alpha.businessId, () => projects.getProject(owner()));
    expect(readBack?.defaultAgentId).toBe(agentId);

    const cleared = await dbLib.withTenant(alpha.businessId, () =>
      projects.updateProject(owner(), { defaultAgentId: null }),
    );
    expect(cleared?.defaultAgentId).toBeNull();
  });

  it("leaves the pin untouched when an update omits defaultAgentId", async () => {
    const agentId = await seedAgent(alpha.businessId, "بازاریابی");
    await dbLib.withTenant(alpha.businessId, () =>
      projects.updateProject(owner(), { defaultAgentId: agentId }),
    );
    // An unrelated edit must not drop the pin.
    const afterRename = await dbLib.withTenant(alpha.businessId, () =>
      projects.updateProject(owner(), { name: "کمپین بهار ۱۴۰۴" }),
    );
    expect(afterRename?.defaultAgentId).toBe(agentId);
  });
});

describe("validation", () => {
  it("refuses a disabled agent", async () => {
    const disabledId = await seedAgent(alpha.businessId, "غیرفعال", false);
    await expect(
      dbLib.withTenant(alpha.businessId, () =>
        projects.updateProject(owner(), { defaultAgentId: disabledId }),
      ),
    ).rejects.toThrow(/project_default_agent_not_found/);
  });

  it("refuses another business's agent", async () => {
    const other = await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`);
    const foreignId = await seedAgent(other.businessId, "بیگانه");
    await expect(
      dbLib.withTenant(alpha.businessId, () =>
        projects.updateProject(owner(), { defaultAgentId: foreignId }),
      ),
    ).rejects.toThrow(/project_default_agent_not_found/);
  });
});

describe("agent lifecycle", () => {
  it("nulls the pin when the pinned agent is deleted (ON DELETE SET NULL)", async () => {
    const agentId = await seedAgent(alpha.businessId, "موقت");
    await dbLib.withTenant(alpha.businessId, () =>
      projects.updateProject(owner(), { defaultAgentId: agentId }),
    );

    await dbLib.withTenant(alpha.businessId, () =>
      agentsSvc.deleteCustomAgent(alpha.businessId, agentId),
    );

    const afterDelete = await dbLib.withTenant(alpha.businessId, () => projects.getProject(owner()));
    expect(afterDelete?.defaultAgentId).toBeNull();
  });
});

describe("prompt context carries the pin", () => {
  it("exposes defaultAgentId on the loaded ProjectContext", async () => {
    const agentId = await seedAgent(alpha.businessId, "بازاریابی");
    await dbLib.withTenant(alpha.businessId, () =>
      projects.updateProject(owner(), { defaultAgentId: agentId }),
    );

    const ctx = await dbLib.withTenant(alpha.businessId, () =>
      projects.getProjectPromptContext(owner()),
    );
    expect(ctx?.defaultAgentId).toBe(agentId);
  });
});
