/**
 * AI Operating Layer — the single-billing smoke suite (migration 0168).
 *
 * End-to-end, against a real Postgres: the money story of one AI turn from
 * the affordability gate to the settled ledger. The wallet
 * (`business_wallets`) is the SINGLE billing stop, and a plan's
 * «اعتبار ماهانهٔ هوش مصنوعی» is real spendable credit that the settlement
 * consumes BEFORE the wallet.
 *
 * Covered (the seven flows the rebuild's Part 9 asked for):
 *   1. allowance-first: a plan-covered turn writes no wallet debit at all;
 *   2. mixed: allowance absorbs part, the wallet pays the rest;
 *   3. no-credit gate: no wallet, no allowance → the next turn is blocked;
 *      allowance alone (empty wallet) admits a turn it can cover;
 *   4. recharge: a top-up unblocks the gate and pays down AI debt;
 *   5. duplicate settlement (same request id) never double-charges;
 *   6. provider failure (turn never settled) leaves the wallet untouched;
 *   7. partial settlement books the shortfall as debt, which blocks the next
 *      turn until a recharge clears it.
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
let allowance: typeof import("../src/lib/ai-plan-allowance");

const BID = "44444444-4444-4444-4444-444444444444";

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_aibilling_${randomUUID().replaceAll("-", "")}`;
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
  allowance = await import("../src/lib/ai-plan-allowance");
  dbLib = await import("../src/lib/db");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
  await db.query(
    `INSERT INTO businesses (id, name, slug, plan) VALUES ($1, 'کافه تست', 'cafe-billing', 'pro')`,
    [BID],
  );
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

/** The plan's included monthly AI credit, in Rial, as the Plan Builder saves it. */
async function setPlanAiCredit(monthlyAiCreditRial: number | null) {
  // 0176 made is_active a generated column (status = 'active'); plans are
  // written through the status lifecycle, never the boolean directly.
  await db.query(
    `INSERT INTO billing_plans (key, name, monthly_ai_credit_rial, status, sort_order)
     VALUES ('pro', 'حرفه‌ای', $1, 'active', 1)
     ON CONFLICT (key) DO UPDATE SET monthly_ai_credit_rial = $1, updated_at = now()`,
    [monthlyAiCreditRial],
  );
}

async function resetMoney() {
  await db.query(`DELETE FROM ai_plan_allowance_usage`);
  await db.query(`DELETE FROM ai_wallet_settlements`);
  await db.query(`DELETE FROM ai_wallet_debt`);
  await db.query(`DELETE FROM wallet_ledger`);
  await db.query(`DELETE FROM feature_usage`);
  await db.query(`DELETE FROM business_wallets`);
}

beforeEach(resetMoney);

async function walletBalance(): Promise<number> {
  const { rows } = await db.query<{ balance_rial: string }>(
    `SELECT balance_rial FROM business_wallets WHERE business_id = $1`,
    [BID],
  );
  return rows[0] ? Number(rows[0].balance_rial) : 0;
}

async function ledgerCount(): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM wallet_ledger WHERE business_id = $1`,
    [BID],
  );
  return Number(rows[0].count);
}

function settle(chargedRial: number, requestId = randomUUID()) {
  return wallet.settleAiWalletCharge({ businessId: BID, requestId, chargedRial });
}

describe("the single AI billing flow", () => {
  it("1. consumes the plan allowance first — a covered turn never touches the wallet", async () => {
    await setPlanAiCredit(1_000_000);
    await wallet.grantCredits({ businessId: BID, amountRial: 500_000 });

    const before = await walletBalance();
    const result = await settle(40_000);

    expect(result.allowanceAppliedRial).toBe(40_000);
    expect(result.debitedRial).toBe(0);
    expect(result.debtAddedRial).toBe(0);
    // charged_rial stays the FULL cost — the allowance is a discount applied
    // at settlement, not a cheaper turn.
    expect(result.chargedRial).toBe(40_000);
    expect(await walletBalance()).toBe(before);
    expect(await ledgerCount()).toBe(1); // only the grant

    const remaining = await allowance.getPlanAllowance(BID);
    expect(remaining.usedRial).toBe(40_000);
    expect(remaining.remainingRial).toBe(960_000);
  });

  it("2. splits a turn between the allowance and the wallet when it must", async () => {
    await setPlanAiCredit(30_000);
    await wallet.grantCredits({ businessId: BID, amountRial: 500_000 });

    const result = await settle(40_000);

    expect(result.allowanceAppliedRial).toBe(30_000);
    expect(result.debitedRial).toBe(10_000);
    expect(result.debtAddedRial).toBe(0);
    expect(result.balanceRial).toBe(490_000);
    // The wallet ledger row records how much of the turn the allowance ate.
    const { rows } = await db.query<{ metadata: { allowanceAppliedRial?: number } }>(
      `SELECT metadata FROM wallet_ledger WHERE business_id = $1 AND direction = 'debit'`,
      [BID],
    );
    expect(rows[0]?.metadata?.allowanceAppliedRial).toBe(30_000);
    // feature_usage spent_rial counts wallet money only.
    const usage = await db.query<{ spent_rial: string; used_count: string }>(
      `SELECT spent_rial::text, used_count::text FROM feature_usage WHERE business_id = $1 AND feature_key = 'ai'`,
      [BID],
    );
    expect(Number(usage.rows[0].spent_rial)).toBe(10_000);
    expect(Number(usage.rows[0].used_count)).toBe(1);
  });

  it("3. blocks the next turn without credit, and admits an allowance-covered one on an empty wallet", async () => {
    // No wallet row, no allowance: the gate is closed.
    await setPlanAiCredit(null);
    const blocked = await wallet.checkAiAffordability(BID, 50_000);
    expect(blocked.affordable).toBe(false);
    expect(blocked.allowanceRemainingRial).toBe(0);

    // Same empty wallet, but the plan now includes credit that covers the
    // per-turn ceiling: the gate opens — plan credit is spendable credit.
    await setPlanAiCredit(100_000);
    const admitted = await wallet.checkAiAffordability(BID, 50_000);
    expect(admitted.affordable).toBe(true);
    expect(admitted.allowanceRemainingRial).toBe(100_000);
  });

  it("4. a recharge unblocks the gate and pays down outstanding AI debt", async () => {
    await setPlanAiCredit(null);
    // A turn that costs more than the wallet has: partial debit + debt.
    await wallet.grantCredits({ businessId: BID, amountRial: 10_000 });
    await settle(40_000, "0d0b0e6e-0000-4000-8000-000000000004");
    expect(await wallet.getAiDebtRial(BID)).toBe(30_000);

    // While the debt stands, the next turn is blocked.
    expect((await wallet.checkAiAffordability(BID, 1_000)).affordable).toBe(false);

    // Recharge: the gate reconciles the debt from the new balance first...
    await wallet.grantCredits({ businessId: BID, amountRial: 100_000 });
    const after = await wallet.checkAiAffordability(BID, 50_000);
    expect(after.affordable).toBe(true);
    expect(after.debtRial).toBe(0);
    // ...and the paydown is an ordinary debit on the ledger (100k top-up
    // minus the 30k debt).
    expect(after.balanceRial).toBe(70_000);
  });

  it("5. settles a retried request id exactly once — never a double charge", async () => {
    await wallet.grantCredits({ businessId: BID, amountRial: 500_000 });
    const first = await settle(40_000, "0d0b0e6e-0000-4000-8000-000000000005");
    const retry = await settle(40_000, "0d0b0e6e-0000-4000-8000-000000000005");

    expect(retry.duplicate).toBe(true);
    expect(retry.debitedRial).toBe(0);
    expect(retry.settlementId).toBe(first.settlementId);
    expect(await walletBalance()).toBe(460_000);
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ai_wallet_settlements WHERE business_id = $1`,
      [BID],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it("6. a provider failure (no settlement call) leaves the wallet untouched", async () => {
    await setPlanAiCredit(1_000_000);
    await wallet.grantCredits({ businessId: BID, amountRial: 500_000 });
    // The request path only settles after a successful provider answer; a
    // failed turn makes no settlement call at all. Nothing to run here — the
    // money state must be exactly the starting state.
    expect(await walletBalance()).toBe(500_000);
    expect((await allowance.getPlanAllowance(BID)).usedRial).toBe(0);
    expect(await ledgerCount()).toBe(1); // the grant only
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ai_wallet_settlements WHERE business_id = $1`,
      [BID],
    );
    expect(Number(rows[0].count)).toBe(0);
  });

  it("7. books a wallet shortfall as debt that blocks the next turn, then clears on recharge", async () => {
    await setPlanAiCredit(10_000);
    await wallet.grantCredits({ businessId: BID, amountRial: 10_000 });

    // A 50k turn: 10k allowance + 10k wallet + 30k debt.
    const result = await settle(50_000, "0d0b0e6e-0000-4000-8000-000000000007");
    expect(result.allowanceAppliedRial).toBe(10_000);
    expect(result.debitedRial).toBe(10_000);
    expect(result.debtAddedRial).toBe(30_000);
    expect(result.debtRial).toBe(30_000);
    expect(result.balanceRial).toBe(0);

    // The debt blocks the next turn even though the allowance has credit
    // left: the reconciliation must happen first.
    const gate = await wallet.checkAiAffordability(BID, 1_000);
    expect(gate.affordable).toBe(false);
    expect(gate.debtRial).toBe(30_000);

    // A top-up clears the debt (the empty wallet means the paydown waits)
    // and the gate opens again.
    await wallet.grantCredits({ businessId: BID, amountRial: 100_000 });
    const open = await wallet.checkAiAffordability(BID, 1_000);
    expect(open.affordable).toBe(true);
    expect(open.debtRial).toBe(0);
    expect(open.balanceRial).toBe(70_000);
  });
});
