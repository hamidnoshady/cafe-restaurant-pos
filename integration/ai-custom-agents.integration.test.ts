/**
 * Phase D — custom agents persist, validate against the live catalogue, and are
 * scoped to one business.
 *
 * Exercises the CRUD service (`ai-custom-agents-service.ts`) against real
 * migrated schema (0154). The pure validation/scoping rules are unit-tested in
 * `src/lib/ai-custom-agents.test.ts`; this proves they hold end-to-end through
 * the database and that RLS-shaped tenant scoping keeps one business's agents
 * out of another's list.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let service: typeof import("../src/lib/ai-custom-agents-service");

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

beforeAll(async () => {
  databaseName = `pos_ai_agents_${randomUUID().replaceAll("-", "")}`;

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
  service = await import("../src/lib/ai-custom-agents-service");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();

  const a = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('Alpha', $1, 'food_service') RETURNING id`,
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = a.rows[0].id;
  const b = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, slug, industry) VALUES ('Beta', $1, 'food_service') RETURNING id`,
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  beta.businessId = b.rows[0].id;
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

describe("custom agents service", () => {
  it("creates, reads back and lists an agent with its allowlists", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createCustomAgent(
        alpha.businessId,
        {
          name: "دستیار انبار",
          instructions: "فقط دربارهٔ موجودی صحبت کن.",
          toolAllowlist: ["find_items", "get_stock_valuation"],
          actionAllowlist: ["inventory.reorder.draftPO"],
        },
        null,
      ),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.agent.name).toBe("دستیار انبار");
    expect(created.agent.toolAllowlist).toEqual(["find_items", "get_stock_valuation"]);
    expect(created.agent.actionAllowlist).toEqual(["inventory.reorder.draftPO"]);
    expect(created.agent.enabled).toBe(true);

    const fetched = await dbLib.withTenant(alpha.businessId, () =>
      service.getCustomAgent(alpha.businessId, created.agent.id),
    );
    expect(fetched?.name).toBe("دستیار انبار");

    const list = await dbLib.withTenant(alpha.businessId, () =>
      service.listCustomAgents(alpha.businessId),
    );
    expect(list.some((a) => a.id === created.agent.id)).toBe(true);
  });

  it("rejects an unknown tool at the service boundary", async () => {
    const result = await dbLib.withTenant(alpha.businessId, () =>
      service.createCustomAgent(alpha.businessId, { name: "بد", toolAllowlist: ["nope"] }, null),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("unknown_tool:nope");
  });

  it("refuses a duplicate name in the same business", async () => {
    const first = await dbLib.withTenant(alpha.businessId, () =>
      service.createCustomAgent(alpha.businessId, { name: "تکراری" }, null),
    );
    expect(first.ok).toBe(true);
    const second = await dbLib.withTenant(alpha.businessId, () =>
      service.createCustomAgent(alpha.businessId, { name: "تکراری" }, null),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.errors).toContain("name_taken");

    // But the same name in a DIFFERENT business is fine.
    const other = await dbLib.withTenant(beta.businessId, () =>
      service.createCustomAgent(beta.businessId, { name: "تکراری" }, null),
    );
    expect(other.ok).toBe(true);
  });

  it("updates and deletes, and reports not_found across a tenant boundary", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      service.createCustomAgent(alpha.businessId, { name: "برای ویرایش" }, null),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await dbLib.withTenant(alpha.businessId, () =>
      service.updateCustomAgent(alpha.businessId, created.agent.id, {
        name: "ویرایش‌شده",
        instructions: "تازه",
        actionAllowlist: [],
        enabled: false,
      }),
    );
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.agent.name).toBe("ویرایش‌شده");
      expect(updated.agent.enabled).toBe(false);
      expect(updated.agent.actionAllowlist).toEqual([]);
    }

    // Beta cannot see or delete Alpha's agent.
    const betaList = await dbLib.withTenant(beta.businessId, () =>
      service.listCustomAgents(beta.businessId),
    );
    expect(betaList.some((a) => a.id === created.agent.id)).toBe(false);
    const betaDelete = await dbLib.withTenant(beta.businessId, () =>
      service.deleteCustomAgent(beta.businessId, created.agent.id),
    );
    expect(betaDelete).toBe(false);

    const alphaDelete = await dbLib.withTenant(alpha.businessId, () =>
      service.deleteCustomAgent(alpha.businessId, created.agent.id),
    );
    expect(alphaDelete).toBe(true);
  });
});
