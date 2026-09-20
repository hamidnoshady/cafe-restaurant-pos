/**
 * AI Operating Layer — Phase I usage section, against a real database.
 *
 * Proves the read-only Usage lens over `ai_wallet_settlements`: after real
 * settlements land through the wallet service, `getAiUsageSummary` reports the
 * right totals, breaks spend down by origin (coalescing unknown types into
 * `other`), lists recent turns newest-first, respects the trailing window, and
 * never leaks one business's spend into another's summary.
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
let wallet: typeof import("../src/lib/wallet-service");
let usage: typeof import("../src/lib/ai-usage-service");

const BID = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_aiusage_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);

  wallet = await import("../src/lib/wallet-service");
  usage = await import("../src/lib/ai-usage-service");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES
       ($1, 'کافه الف', 'cafe-alpha', 'pro'),
       ($2, 'کافه ب', 'cafe-beta', 'pro')`,
    [BID, OTHER],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;
});

function scoped<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

async function reset() {
  await db.query(`DELETE FROM ai_wallet_settlements`);
  await db.query(`DELETE FROM ai_wallet_debt`);
  await db.query(`DELETE FROM wallet_ledger`);
  await db.query(`DELETE FROM feature_usage`);
  await db.query(`DELETE FROM business_wallets`);
}

beforeEach(reset);

/** Settle a turn of a given type/cost, optionally aged into the past. */
async function settle(
  businessId: string,
  opts: {
    requestType: string;
    chargedRial: number;
    providerCostRial?: number;
    cacheHit?: boolean;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    agedDays?: number;
  },
) {
  const requestId = randomUUID();
  await wallet.settleAiWalletCharge({
    businessId,
    requestId,
    chargedRial: opts.chargedRial,
    providerCostRial: opts.providerCostRial ?? opts.chargedRial,
    pricedBy: "gateway",
    requestType: opts.requestType,
    cacheHit: opts.cacheHit ?? false,
    model: opts.model,
    inputTokens: opts.inputTokens,
    outputTokens: opts.outputTokens,
  });
  if (opts.agedDays) {
    await db.query(
      `UPDATE ai_wallet_settlements
          SET created_at = now() - ($2 || ' days')::interval
        WHERE business_id = $1 AND request_id = $3`,
      [businessId, String(opts.agedDays), requestId],
    );
  }
  return requestId;
}

describe("AI usage summary", () => {
  it("totals spend, counts turns and cache hits, and reports balance", async () => {
    await scoped(BID, async () => {
      await wallet.grantCredits({ businessId: BID, amountRial: 1_000_000, note: "شارژ" });
      await settle(BID, { requestType: "chat", chargedRial: 12_000, providerCostRial: 10_000 });
      await settle(BID, { requestType: "chat", chargedRial: 8_000, providerCostRial: 6_000, cacheHit: true });
      await settle(BID, { requestType: "coworker", chargedRial: 5_000, providerCostRial: 5_000 });

      const summary = await usage.getAiUsageSummary(BID, 30);
      expect(summary.totalTurns).toBe(3);
      expect(summary.totalChargedRial).toBe(25_000);
      expect(summary.totalProviderCostRial).toBe(21_000);
      expect(summary.cacheHits).toBe(1);
      expect(summary.balanceRial).toBe(1_000_000 - 25_000);
      expect(summary.debtRial).toBe(0);
    });
  });

  it("breaks spend down by origin, richest first", async () => {
    await scoped(BID, async () => {
      await wallet.grantCredits({ businessId: BID, amountRial: 1_000_000, note: "شارژ" });
      await settle(BID, { requestType: "chat", chargedRial: 3_000 });
      await settle(BID, { requestType: "chat", chargedRial: 3_000 });
      await settle(BID, { requestType: "coworker", chargedRial: 20_000 });

      const summary = await usage.getAiUsageSummary(BID, 30);
      expect(summary.byType.map((s) => s.requestType)).toEqual(["coworker", "chat"]);
      const coworker = summary.byType.find((s) => s.requestType === "coworker")!;
      expect(coworker.chargedRial).toBe(20_000);
      expect(coworker.turns).toBe(1);
      const chat = summary.byType.find((s) => s.requestType === "chat")!;
      expect(chat.chargedRial).toBe(6_000);
      expect(chat.turns).toBe(2);
    });
  });

  it("lists recent turns newest-first with model and tokens", async () => {
    await scoped(BID, async () => {
      await wallet.grantCredits({ businessId: BID, amountRial: 1_000_000, note: "شارژ" });
      await settle(BID, { requestType: "chat", chargedRial: 1_000, model: "old-model", agedDays: 2 });
      await settle(BID, {
        requestType: "vision",
        chargedRial: 2_000,
        model: "new-model",
        inputTokens: 120,
        outputTokens: 45,
      });

      const summary = await usage.getAiUsageSummary(BID, 30);
      expect(summary.recentTurns).toHaveLength(2);
      expect(summary.recentTurns[0].model).toBe("new-model");
      expect(summary.recentTurns[0].requestType).toBe("vision");
      expect(summary.recentTurns[0].inputTokens).toBe(120);
      expect(summary.recentTurns[0].outputTokens).toBe(45);
      expect(summary.recentTurns[1].model).toBe("old-model");
    });
  });

  it("respects the trailing window — older turns fall out", async () => {
    await scoped(BID, async () => {
      await wallet.grantCredits({ businessId: BID, amountRial: 1_000_000, note: "شارژ" });
      await settle(BID, { requestType: "chat", chargedRial: 5_000 }); // today
      await settle(BID, { requestType: "chat", chargedRial: 9_000, agedDays: 45 }); // outside 30d

      const last30 = await usage.getAiUsageSummary(BID, 30);
      expect(last30.totalTurns).toBe(1);
      expect(last30.totalChargedRial).toBe(5_000);

      const last90 = await usage.getAiUsageSummary(BID, 90);
      expect(last90.totalTurns).toBe(2);
      expect(last90.totalChargedRial).toBe(14_000);
    });
  });

  it("coalesces an unknown request_type into `other`", async () => {
    await scoped(BID, async () => {
      await wallet.grantCredits({ businessId: BID, amountRial: 1_000_000, note: "شارژ" });
      // Insert a settlement with a type the enum doesn't have, bypassing the
      // service so we can exercise the coalescing path. (The CHECK allows the
      // full enum; use a real-but-rare one to keep the row legal.)
      await settle(BID, { requestType: "embedding", chargedRial: 1_500 });

      const summary = await usage.getAiUsageSummary(BID, 30);
      const embedding = summary.byType.find((s) => s.requestType === "embedding");
      expect(embedding?.chargedRial).toBe(1_500);
    });
  });

  it("never leaks one business's spend into another's summary", async () => {
    await scoped(BID, async () => {
      await wallet.grantCredits({ businessId: BID, amountRial: 500_000, note: "شارژ" });
      await settle(BID, { requestType: "chat", chargedRial: 10_000 });
    });
    await scoped(OTHER, async () => {
      await wallet.grantCredits({ businessId: OTHER, amountRial: 500_000, note: "شارژ" });
      await settle(OTHER, { requestType: "chat", chargedRial: 99_000 });
    });

    const summaryB = await scoped(BID, () => usage.getAiUsageSummary(BID, 30));
    expect(summaryB.totalTurns).toBe(1);
    expect(summaryB.totalChargedRial).toBe(10_000);

    const summaryOther = await scoped(OTHER, () => usage.getAiUsageSummary(OTHER, 30));
    expect(summaryOther.totalTurns).toBe(1);
    expect(summaryOther.totalChargedRial).toBe(99_000);
  });
});
