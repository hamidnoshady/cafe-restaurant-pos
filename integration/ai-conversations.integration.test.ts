/**
 * AI Hub Wave 1 (Issue #141) exit criterion, against a real database.
 *
 * The generic `tenant-isolation.integration.test.ts` proves ai_conversations/
 * ai_messages carry RLS like every other tenant table, but RLS alone only
 * draws the business boundary. This wave's product decision goes narrower —
 * a conversation is visible only to the member who started it, not the whole
 * business — and that ownership boundary is enforced by ai-conversations.ts,
 * not by a database policy, so it needs its own coverage: user A must not be
 * able to read or delete user B's conversation even though both share one
 * business (and therefore one RLS scope).
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

let ai: typeof import("../src/lib/ai-conversations");
let dbLib: typeof import("../src/lib/db");

const alpha = { businessId: "", userA: "", userB: "" };
const beta = { businessId: "", userA: "" };

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
  databaseName = `pos_ai_conv_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  ai = await import("../src/lib/ai-conversations");
  dbLib = await import("../src/lib/db");

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
  await db.query("DELETE FROM businesses");
  const alphaBiz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Alpha', $1) RETURNING id",
    [`alpha-${randomUUID().slice(0, 8)}`],
  );
  const betaBiz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('Beta', $1) RETURNING id",
    [`beta-${randomUUID().slice(0, 8)}`],
  );
  alpha.businessId = alphaBiz.rows[0].id;
  alpha.userA = randomUUID();
  alpha.userB = randomUUID();
  beta.businessId = betaBiz.rows[0].id;
  beta.userA = randomUUID();
});

/** Runs `fn` scoped to a business, the way an authenticated request would be. */
function asBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

describe("conversation ownership within one business", () => {
  it("keeps user A's conversation out of user B's list, get, and delete", async () => {
    const created = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "فروش امروز چقدر بود؟",
      }),
    );
    expect(created.isNew).toBe(true);
    await asBusiness(alpha.businessId, () =>
      ai.appendMessage({ conversationId: created.id, role: "user", content: "فروش امروز چقدر بود؟" }),
    );

    const bList = await asBusiness(alpha.businessId, () =>
      ai.listConversations({ businessId: alpha.businessId, actorUserId: alpha.userB }),
    );
    expect(bList).toHaveLength(0);

    const bGet = await asBusiness(alpha.businessId, () =>
      ai.getConversationMessages({
        businessId: alpha.businessId,
        actorUserId: alpha.userB,
        conversationId: created.id,
      }),
    );
    expect(bGet).toBeNull();

    const bDelete = await asBusiness(alpha.businessId, () =>
      ai.deleteConversation({ businessId: alpha.businessId, actorUserId: alpha.userB, conversationId: created.id }),
    );
    expect(bDelete).toBe(false);

    const aList = await asBusiness(alpha.businessId, () =>
      ai.listConversations({ businessId: alpha.businessId, actorUserId: alpha.userA }),
    );
    expect(aList).toHaveLength(1);
    expect(aList[0].id).toBe(created.id);
  });

  it("never resumes another user's conversation id — starts a new one instead", async () => {
    const ownedByA = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "گزارش هفتگی",
      }),
    );

    const resumedByB = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userB,
        mode: "dashboard",
        conversationId: ownedByA.id,
        firstMessageContent: "موجودی انبار",
      }),
    );

    expect(resumedByB.isNew).toBe(true);
    expect(resumedByB.id).not.toBe(ownedByA.id);
  });

  it("does not resume across businesses even for a matching conversation id (defense in depth over RLS)", async () => {
    const ownedByAlpha = await asBusiness(alpha.businessId, () =>
      ai.getOrCreateConversation({
        businessId: alpha.businessId,
        actorUserId: alpha.userA,
        mode: "dashboard",
        conversationId: null,
        firstMessageContent: "سود امروز",
      }),
    );

    const resumedFromBeta = await asBusiness(beta.businessId, () =>
      ai.getOrCreateConversation({
        businessId: beta.businessId,
        actorUserId: beta.userA,
        mode: "dashboard",
        conversationId: ownedByAlpha.id,
        firstMessageContent: "سود امروز",
      }),
    );

    expect(resumedFromBeta.isNew).toBe(true);
    expect(resumedFromBeta.id).not.toBe(ownedByAlpha.id);
  });
});
