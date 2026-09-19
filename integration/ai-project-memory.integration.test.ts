/**
 * Phase F, Part 1 — project memory + live project prompt context, against a
 * real database.
 *
 * `tenant-isolation.integration.test.ts` already proves ai_project_memory
 * carries RLS like every other tenant table. This file proves the behaviour the
 * feature exists for:
 *
 *   - a memory entry is created against a project and read back;
 *   - the char-length and entry-count bounds are enforced server-side;
 *   - a memory entry is forgotten (deleted);
 *   - getProjectPromptContext loads instructions + notes + memory in one pass
 *     and buildProjectPromptContext renders them — the round-trip that finally
 *     makes a project shape a turn (the dead-code gap this phase closes).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { PROJECT_MEMORY_CHAR_LIMIT, PROJECT_MEMORY_MAX_ENTRIES } from "../src/lib/ai-projects-shared";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let projects: typeof import("../src/lib/ai-projects");

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
  databaseName = `pos_ai_projmem_${randomUUID().replaceAll("-", "")}`;

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

beforeEach(async () => {
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`));

  const project = await dbLib.withTenant(alpha.businessId, () =>
    projects.createProject(
      { businessId: alpha.businessId, actorUserId: alpha.userId },
      { name: "کمپین بهار", instructions: "لحن دوستانه داشته باش" },
    ),
  );
  alpha.projectId = project.id;
});

function owner() {
  return { businessId: alpha.businessId, actorUserId: alpha.userId, projectId: alpha.projectId };
}

describe("creating and reading memory", () => {
  it("stores a memory entry and reads it back", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      projects.addMemory(owner(), { content: "مالک تومان را رند می‌کند" }),
    );
    expect(created.source).toBe("user");
    expect(created.content).toBe("مالک تومان را رند می‌کند");

    const list = await dbLib.withTenant(alpha.businessId, () => projects.listMemory(owner()));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
  });

  it("records an AI-sourced memory with its provenance", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      projects.addMemory(owner(), { content: "مشتریان هدف ناهارِ ازدست‌رفته", source: "ai" }),
    );
    expect(created.source).toBe("ai");
  });
});

describe("bounds", () => {
  it("refuses an over-length memory entry", async () => {
    await expect(
      dbLib.withTenant(alpha.businessId, () =>
        projects.addMemory(owner(), { content: "x".repeat(PROJECT_MEMORY_CHAR_LIMIT + 1) }),
      ),
    ).rejects.toThrow(/character limit/);
  });

  it("refuses an empty memory entry", async () => {
    await expect(
      dbLib.withTenant(alpha.businessId, () => projects.addMemory(owner(), { content: "   " })),
    ).rejects.toThrow(/required/);
  });

  it("refuses a memory entry once the project is full", async () => {
    for (let i = 0; i < PROJECT_MEMORY_MAX_ENTRIES; i++) {
      await dbLib.withTenant(alpha.businessId, () =>
        projects.addMemory(owner(), { content: `fact ${i}` }),
      );
    }
    await expect(
      dbLib.withTenant(alpha.businessId, () => projects.addMemory(owner(), { content: "one too many" })),
    ).rejects.toThrow(/full/);
  });
});

describe("forgetting", () => {
  it("deletes a memory entry", async () => {
    const created = await dbLib.withTenant(alpha.businessId, () =>
      projects.addMemory(owner(), { content: "fact to forget" }),
    );
    const ok = await dbLib.withTenant(alpha.businessId, () =>
      projects.deleteMemory({ ...owner(), memoryId: created.id }),
    );
    expect(ok).toBe(true);
    const list = await dbLib.withTenant(alpha.businessId, () => projects.listMemory(owner()));
    expect(list).toHaveLength(0);
  });
});

describe("prompt context round-trip (the dead-code gap this phase closes)", () => {
  it("loads instructions + notes + memory and renders them into one block", async () => {
    await dbLib.withTenant(alpha.businessId, async () => {
      await projects.addNote(owner(), { title: "بودجهٔ کمپین", content: "" });
      await projects.addMemory(owner(), { content: "هفتهٔ اول تخفیف ندارد" });
    });

    const ctx = await dbLib.withTenant(alpha.businessId, () =>
      projects.getProjectPromptContext(owner()),
    );
    expect(ctx).not.toBeNull();
    if (!ctx) return;

    const rendered = projects.buildProjectPromptContext(ctx);
    expect(rendered).toContain("کمپین بهار"); // name
    expect(rendered).toContain("لحن دوستانه داشته باش"); // instruction
    expect(rendered).toContain("بودجهٔ کمپین"); // note title
    expect(rendered).toContain("هفتهٔ اول تخفیف ندارد"); // memory
    expect(rendered).toContain("حافظهٔ پروژه");
  });

  it("returns null for a project this tenant does not own", async () => {
    const other = await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`);
    const ctx = await dbLib.withTenant(other.businessId, () =>
      projects.getProjectPromptContext({
        businessId: other.businessId,
        actorUserId: other.userId,
        projectId: alpha.projectId,
      }),
    );
    expect(ctx).toBeNull();
  });
});
