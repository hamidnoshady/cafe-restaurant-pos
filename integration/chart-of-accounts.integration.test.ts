/**
 * Phase 16 scope: "Per-business chart of accounts — customisation,
 * sub-accounts, and account archival that respects existing postings."
 * `accounts.parent_id`/`is_active` have existed since Phase 1; this proves
 * the CRUD built on top of them: sub-accounts, renaming, reparenting
 * (including cycle rejection), archiving (blocked for well-known codes,
 * allowed regardless of history), and deletion (only ever for an account
 * nothing has posted to, real or drafted, and with no sub-accounts).
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
let accountsService: typeof import("../src/lib/accounts-service");
let manualJournal: typeof import("../src/lib/manual-journal-service");

const biz = { id: "" };
const acct = { cash: "", expense: "", expenseParent: "" };
const user = { id: "" };

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
  databaseName = `pos_coa_${randomUUID().replaceAll("-", "")}`;

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
  accountsService = await import("../src/lib/accounts-service");
  manualJournal = await import("../src/lib/manual-journal-service");

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
  await db.query("DELETE FROM journal_entry_draft_lines");
  await db.query("DELETE FROM journal_entry_drafts");
  await db.query("DELETE FROM journal_lines");
  await db.query("DELETE FROM journal_entries");
  await db.query("DELETE FROM businesses");

  const bizRow = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ('COA Co', $1) RETURNING id",
    [`coa-${randomUUID().slice(0, 8)}`],
  );
  biz.id = bizRow.rows[0].id;

  const userRow = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, pin_hash) VALUES ($1, 'owner', 'Owner', 'x') RETURNING id`,
    [biz.id],
  );
  user.id = userRow.rows[0].id;

  const accounts = await db.query<{ id: string; code: string }>(
    `INSERT INTO accounts (business_id, code, name, type)
     VALUES ($1, '1100', 'Cash', 'asset'), ($1, '5000', 'Expenses', 'expense'), ($1, '5300', 'Rent', 'expense')
     RETURNING id, code`,
    [biz.id],
  );
  for (const r of accounts.rows) {
    if (r.code === "1100") acct.cash = r.id;
    if (r.code === "5000") acct.expenseParent = r.id;
    if (r.code === "5300") acct.expense = r.id;
  }
  await db.query("UPDATE accounts SET parent_id = $1 WHERE id = $2", [acct.expenseParent, acct.expense]);
});

describe("createAccount", () => {
  it("adds a sub-account under an existing parent", async () => {
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "5310",
      name: "Marketing",
      type: "expense",
      parentId: acct.expenseParent,
    });
    const list = await accountsService.listAccounts(biz.id);
    const created = list.find((a) => a.id === id);
    expect(created).toMatchObject({ code: "5310", name: "Marketing", type: "expense", parentId: acct.expenseParent, isActive: true });
  });

  it("rejects a duplicate code", async () => {
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "1100", name: "Dup", type: "asset" }),
    ).rejects.toThrow("code_in_use");
  });

  it("rejects an unknown parent", async () => {
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "5320", name: "X", type: "expense", parentId: randomUUID() }),
    ).rejects.toThrow("parent_not_found");
  });

  it("rejects an empty name or invalid type", async () => {
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "5330", name: "  ", type: "expense" }),
    ).rejects.toThrow("name_required");
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "5340", name: "X", type: "bogus" }),
    ).rejects.toThrow("invalid_type");
  });
});

describe("renameAccount", () => {
  it("renames without touching code or type", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Rent expense (renamed)");
    const list = await accountsService.listAccounts(biz.id);
    const row = list.find((a) => a.id === acct.expense)!;
    expect(row.name).toBe("Rent expense (renamed)");
    expect(row.code).toBe("5300");
  });

  it("404s renaming an account that doesn't exist", async () => {
    await expect(accountsService.renameAccount(biz.id, randomUUID(), "X")).rejects.toThrow("account_not_found");
  });
});

describe("reparentAccount", () => {
  it("moves an account under a new parent", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, acct.cash);
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.parentId).toBe(acct.cash);
  });

  it("clears the parent when given null", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, null);
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.parentId).toBeNull();
  });

  it("rejects making an account its own parent", async () => {
    await expect(accountsService.reparentAccount(biz.id, acct.expense, acct.expense)).rejects.toThrow("parent_cycle");
  });

  it("rejects a cycle through a chain of descendants", async () => {
    // expenseParent (5000) is currently the parent of expense (5300).
    // Making expenseParent a child of expense would create a cycle.
    await expect(accountsService.reparentAccount(biz.id, acct.expenseParent, acct.expense)).rejects.toThrow("parent_cycle");
  });
});

describe("setAccountActive (archive/restore)", () => {
  it("archives and restores an ordinary account, keeping it in the list either way", async () => {
    await accountsService.setAccountActive(biz.id, acct.expense, false);
    let list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.isActive).toBe(false);

    await accountsService.setAccountActive(biz.id, acct.expense, true);
    list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.isActive).toBe(true);
  });

  it("archiving does not remove or hide the account's history", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Rent",
      lines: [
        { accountId: acct.expense, debit: 50_000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 50_000 },
      ],
      createdBy: user.id,
    });
    await manualJournal.approveDraft({ businessId: biz.id, locationId: null, draftId: draft.id, actorId: user.id });

    await accountsService.setAccountActive(biz.id, acct.expense, false);

    const { rows } = await db.query("SELECT count(*)::int AS n FROM journal_lines WHERE account_id = $1", [acct.expense]);
    expect(rows[0].n).toBe(1);

    const list = await accountsService.listAccounts(biz.id);
    const row = list.find((a) => a.id === acct.expense)!;
    expect(row.isActive).toBe(false);
    expect(row.hasPostings).toBe(true);
  });

  it("refuses to archive a well-known account", async () => {
    await expect(accountsService.setAccountActive(biz.id, acct.cash, false)).rejects.toThrow("well_known_account");
  });

  it("an archived account can no longer be drafted against", async () => {
    await accountsService.setAccountActive(biz.id, acct.expense, false);
    await expect(
      manualJournal.createDraft({
        businessId: biz.id,
        locationId: null,
        memo: "Rent",
        lines: [
          { accountId: acct.expense, debit: 10_000, credit: 0 },
          { accountId: acct.cash, debit: 0, credit: 10_000 },
        ],
        createdBy: user.id,
      }),
    ).rejects.toThrow("unknown_account");
  });
});

describe("deleteAccount", () => {
  it("deletes an account that was never posted to", async () => {
    const { id } = await accountsService.createAccount({ businessId: biz.id, code: "5320", name: "Unused", type: "expense" });
    await accountsService.deleteAccount(biz.id, id);
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === id)).toBeUndefined();
  });

  it("refuses to delete an account with real postings", async () => {
    const draft = await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Rent",
      lines: [
        { accountId: acct.expense, debit: 50_000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 50_000 },
      ],
      createdBy: user.id,
    });
    await manualJournal.approveDraft({ businessId: biz.id, locationId: null, draftId: draft.id, actorId: user.id });

    await expect(accountsService.deleteAccount(biz.id, acct.expense)).rejects.toThrow("account_has_postings");
  });

  it("refuses to delete an account with a pending draft posting", async () => {
    await manualJournal.createDraft({
      businessId: biz.id,
      locationId: null,
      memo: "Rent",
      lines: [
        { accountId: acct.expense, debit: 10_000, credit: 0 },
        { accountId: acct.cash, debit: 0, credit: 10_000 },
      ],
      createdBy: user.id,
    });

    await expect(accountsService.deleteAccount(biz.id, acct.expense)).rejects.toThrow("account_has_draft_postings");
  });

  it("refuses to delete an account that still has sub-accounts", async () => {
    await expect(accountsService.deleteAccount(biz.id, acct.expenseParent)).rejects.toThrow("account_has_children");
  });

  it("refuses to delete a well-known account", async () => {
    await expect(accountsService.deleteAccount(biz.id, acct.cash)).rejects.toThrow("well_known_account");
  });
});
