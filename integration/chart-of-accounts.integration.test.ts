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
let auditService: typeof import("../src/lib/audit-service");
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
  auditService = await import("../src/lib/audit-service");
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

describe("account levels (گروه/کل/معین/تفصیلی)", () => {
  it("assigns group to a root account and cascades kol -> moein -> tafsili down a chain", async () => {
    const { id: groupId } = await accountsService.createAccount({
      businessId: biz.id,
      code: "6000",
      name: "Root",
      type: "expense",
    });
    const { id: kolId } = await accountsService.createAccount({
      businessId: biz.id,
      code: "6100",
      name: "Kol",
      type: "expense",
      parentId: groupId,
    });
    const { id: moeinId } = await accountsService.createAccount({
      businessId: biz.id,
      code: "6110",
      name: "Moein",
      type: "expense",
      parentId: kolId,
    });
    const { id: tafsiliId } = await accountsService.createAccount({
      businessId: biz.id,
      code: "6111",
      name: "Tafsili",
      type: "expense",
      parentId: moeinId,
    });

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === groupId)!.level).toBe("group");
    expect(list.find((a) => a.id === kolId)!.level).toBe("kol");
    expect(list.find((a) => a.id === moeinId)!.level).toBe("moein");
    expect(list.find((a) => a.id === tafsiliId)!.level).toBe("tafsili");
  });

  it("refuses to add a child under a تفصیلی account", async () => {
    const { id: groupId } = await accountsService.createAccount({ businessId: biz.id, code: "6200", name: "G", type: "expense" });
    const { id: kolId } = await accountsService.createAccount({ businessId: biz.id, code: "6210", name: "K", type: "expense", parentId: groupId });
    const { id: moeinId } = await accountsService.createAccount({ businessId: biz.id, code: "6211", name: "M", type: "expense", parentId: kolId });
    const { id: tafsiliId } = await accountsService.createAccount({ businessId: biz.id, code: "6212", name: "T", type: "expense", parentId: moeinId });

    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "6213", name: "TooDeep", type: "expense", parentId: tafsiliId }),
    ).rejects.toThrow("parent_too_deep");
  });

  it("reparenting cascades the new level down to every descendant", async () => {
    const { id: groupA } = await accountsService.createAccount({ businessId: biz.id, code: "6300", name: "A", type: "expense" });
    const { id: groupB } = await accountsService.createAccount({ businessId: biz.id, code: "6400", name: "B", type: "expense" });
    const { id: kol } = await accountsService.createAccount({ businessId: biz.id, code: "6310", name: "Kol", type: "expense", parentId: groupA });
    const { id: moein } = await accountsService.createAccount({ businessId: biz.id, code: "6311", name: "Moein", type: "expense", parentId: kol });

    // Move `kol` (and its descendant `moein`) under groupB's own kol level
    // by first nesting groupB one level deeper, then reparenting `kol` there —
    // pushing `kol` from kol-level to moein-level, and `moein` to tafsili-level.
    const { id: kolB } = await accountsService.createAccount({ businessId: biz.id, code: "6410", name: "KolB", type: "expense", parentId: groupB });
    await accountsService.reparentAccount(biz.id, kol, kolB);

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === kol)!.level).toBe("moein");
    expect(list.find((a) => a.id === moein)!.level).toBe("tafsili");
  });

  it("refuses a reparent that would push a descendant past تفصیلی", async () => {
    const { id: groupA } = await accountsService.createAccount({ businessId: biz.id, code: "6500", name: "A", type: "expense" });
    const { id: kol } = await accountsService.createAccount({ businessId: biz.id, code: "6510", name: "Kol", type: "expense", parentId: groupA });
    const { id: moein } = await accountsService.createAccount({ businessId: biz.id, code: "6511", name: "Moein", type: "expense", parentId: kol });
    await accountsService.createAccount({ businessId: biz.id, code: "6512", name: "Tafsili", type: "expense", parentId: moein });

    const { id: groupB } = await accountsService.createAccount({ businessId: biz.id, code: "6600", name: "B", type: "expense" });
    const { id: kolB } = await accountsService.createAccount({ businessId: biz.id, code: "6610", name: "KolB", type: "expense", parentId: groupB });
    const { id: moeinB } = await accountsService.createAccount({ businessId: biz.id, code: "6611", name: "MoeinB", type: "expense", parentId: kolB });

    // `kol`'s subtree is 3 levels deep (kol -> moein -> tafsili); reparenting
    // it under moeinB (already تفصیلی-next) would push its tafsili-level
    // grandchild past the deepest tier.
    await expect(accountsService.reparentAccount(biz.id, kol, moeinB)).rejects.toThrow("hierarchy_too_deep");
  });

  it("clearing the parent resets an account (and its descendants) back to group/kol", async () => {
    const { id: groupA } = await accountsService.createAccount({ businessId: biz.id, code: "6700", name: "A", type: "expense" });
    const { id: kol } = await accountsService.createAccount({ businessId: biz.id, code: "6710", name: "Kol", type: "expense", parentId: groupA });
    const { id: moein } = await accountsService.createAccount({ businessId: biz.id, code: "6711", name: "Moein", type: "expense", parentId: kol });

    await accountsService.reparentAccount(biz.id, kol, null);

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === kol)!.level).toBe("group");
    expect(list.find((a) => a.id === moein)!.level).toBe("kol");
  });
});

describe("account nature (normal balance & contra)", () => {
  it("stores debit-normal for asset/expense and credit-normal for liability/equity/revenue", async () => {
    const asset = await accountsService.createAccount({ businessId: biz.id, code: "6800", name: "Asset", type: "asset" });
    const liability = await accountsService.createAccount({ businessId: biz.id, code: "6801", name: "Liability", type: "liability" });
    const equity = await accountsService.createAccount({ businessId: biz.id, code: "6802", name: "Equity", type: "equity" });
    const revenue = await accountsService.createAccount({ businessId: biz.id, code: "6803", name: "Revenue", type: "revenue" });
    const expense = await accountsService.createAccount({ businessId: biz.id, code: "6804", name: "Expense", type: "expense" });

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === asset.id)!.normalBalance).toBe("debit");
    expect(list.find((a) => a.id === liability.id)!.normalBalance).toBe("credit");
    expect(list.find((a) => a.id === equity.id)!.normalBalance).toBe("credit");
    expect(list.find((a) => a.id === revenue.id)!.normalBalance).toBe("credit");
    expect(list.find((a) => a.id === expense.id)!.normalBalance).toBe("debit");
  });

  it("persists an explicit isContra flag, defaulting to false", async () => {
    const contra = await accountsService.createAccount({ businessId: biz.id, code: "6900", name: "Returns", type: "revenue", isContra: true });
    const normal = await accountsService.createAccount({ businessId: biz.id, code: "6901", name: "Sales", type: "revenue" });

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === contra.id)!.isContra).toBe(true);
    expect(list.find((a) => a.id === normal.id)!.isContra).toBe(false);
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

describe("account audit trail (issue #160 §7.5)", () => {
  it("records who renamed an account, and its before/after name", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Rent (renamed)", user.id);

    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entry.action).toBe("account.renamed");
    expect(entry.actorId).toBe(user.id);
    expect(entry.payload).toEqual({ before: "Rent", after: "Rent (renamed)" });
  });

  it("records nothing when a rename is a no-op (same name)", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Rent", user.id);
    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entries).toEqual([]);
  });

  it("records a reparent with before/after parent labels resolved live", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, acct.cash, user.id);

    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entry.action).toBe("account.reparented");
    expect(entry.accountBeforeParentLabel).toBe("5000 — Expenses");
    expect(entry.accountAfterParentLabel).toBe("1100 — Cash");
  });

  it("records a reparent to no parent (top-level) with a null after-label", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, null, user.id);

    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entry.action).toBe("account.reparented");
    expect(entry.accountBeforeParentLabel).toBe("5000 — Expenses");
    expect(entry.accountAfterParentLabel).toBeNull();
  });

  it("records nothing when a reparent is a no-op (same parent)", async () => {
    await accountsService.reparentAccount(biz.id, acct.expense, acct.expenseParent, user.id);
    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entries).toEqual([]);
  });

  it("records an archive and a later reactivate as two distinct actions", async () => {
    await accountsService.setAccountActive(biz.id, acct.expense, false, user.id);
    await accountsService.setAccountActive(biz.id, acct.expense, true, user.id);

    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entries.map((e) => e.action)).toEqual(["account.reactivated", "account.archived"]);
  });

  it("the account's own current code/name resolve as entityName, even after a later rename", async () => {
    await accountsService.setAccountActive(biz.id, acct.expense, false, user.id);
    await accountsService.renameAccount(biz.id, acct.expense, "Rent v2", user.id);

    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    const archiveEntry = entries.find((e) => e.action === "account.archived")!;
    expect(archiveEntry.entityName).toBe("5300 — Rent v2");
  });
});

/**
 * The bugs a chart-of-accounts screen actually hits: an id that is not a uuid,
 * a Persian-digit code, a half-applied combined edit, and a repeated archive.
 */
describe("chart-of-accounts hardening", () => {
  it("404s (never 500s) for an id that is not a uuid", async () => {
    // `WHERE id = $1` against a uuid column raises `invalid input syntax for
    // type uuid` for anything else, which used to surface as a 500 and the
    // generic «خطای غیرمنتظره» — see uuid.ts.
    await expect(accountsService.renameAccount(biz.id, "not-a-uuid", "X")).rejects.toThrow("account_not_found");
    await expect(accountsService.deleteAccount(biz.id, "not-a-uuid")).rejects.toThrow("account_not_found");
    await expect(accountsService.setAccountActive(biz.id, "not-a-uuid", false)).rejects.toThrow("account_not_found");
  });

  it("never touches another business's account", async () => {
    const otherBiz = await db.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ('Other Co', $1) RETURNING id",
      [`other-${randomUUID().slice(0, 8)}`],
    );
    await expect(accountsService.renameAccount(otherBiz.rows[0].id, acct.expense, "Hijacked")).rejects.toThrow(
      "account_not_found",
    );
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.name).toBe("Rent");
  });

  it("stores a Persian-digit code as ASCII, so well-known lookups still find it", async () => {
    // Auto-posting looks accounts up by code (WELL_KNOWN_CODES). A code saved
    // as «۶۱۰۰» is a different string from "6100" and nothing would find it.
    const { id } = await accountsService.createAccount({
      businessId: biz.id,
      code: "۶۱۰۰",
      name: "Persian digits",
      type: "expense",
    });
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === id)!.code).toBe("6100");
  });

  it("treats a Persian-digit duplicate as the duplicate it is", async () => {
    await expect(
      accountsService.createAccount({ businessId: biz.id, code: "۵۳۰۰", name: "Dup", type: "expense" }),
    ).rejects.toThrow("code_in_use");
  });

  it("applies a rename and a reparent atomically — a rejected move rolls the rename back", async () => {
    // The bug: the route ran rename, then reparent. A move the hierarchy rules
    // refuse left the account renamed and the caller holding an error.
    await expect(
      accountsService.updateAccount({
        businessId: biz.id,
        id: acct.expense,
        name: "Renamed but not moved",
        parentId: acct.expense, // its own parent — always rejected
        reparent: true,
      }),
    ).rejects.toThrow("parent_cycle");

    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.name).toBe("Rent");
  });

  it("applies a combined rename + reparent in one call", async () => {
    await accountsService.updateAccount({
      businessId: biz.id,
      id: acct.expense,
      actorId: user.id,
      name: "Rent & moved",
      parentId: null,
      reparent: true,
    });
    const list = await accountsService.listAccounts(biz.id);
    const row = list.find((a) => a.id === acct.expense)!;
    expect(row.name).toBe("Rent & moved");
    expect(row.parentId).toBeNull();

    const actions = (await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense })).map(
      (e) => e.action,
    );
    expect(actions).toContain("account.renamed");
    expect(actions).toContain("account.reparented");
  });

  it("records nothing when an archive is a no-op (already archived)", async () => {
    // Rename and reparent have always skipped their no-ops; archiving wrote a
    // fresh row every time, so a double-click invented history.
    await accountsService.setAccountActive(biz.id, acct.expense, false, user.id);
    await accountsService.setAccountActive(biz.id, acct.expense, false, user.id);

    const entries = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entries.filter((e) => e.action === "account.archived")).toHaveLength(1);
  });

  it("writes the audit row in the same transaction as the change", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Audited rename", user.id);
    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    const { rows } = await db.query<{ name: string }>("SELECT name FROM accounts WHERE id = $1", [acct.expense]);
    expect(rows[0].name).toBe("Audited rename");
    expect(entry.payload).toEqual({ before: "Rent", after: "Audited rename" });
  });

  it("rejects a blank rename without writing anything", async () => {
    await expect(accountsService.renameAccount(biz.id, acct.expense, "   ")).rejects.toThrow("name_required");
    const list = await accountsService.listAccounts(biz.id);
    expect(list.find((a) => a.id === acct.expense)!.name).toBe("Rent");
  });
});

describe("the audit trail survives rows a settings writer logged", () => {
  // `audit_log.entity_id` is text, and the settings writers do not put a uuid
  // in it (`settings.mfa_policy.update` logs 'mfa.policy',
  // `settings.business.update` logs 'business'). The trail's joins used to
  // cast the column bare, so ONE such row made listAuditLog — and with it the
  // whole audit tab — throw `invalid input syntax for type uuid` for every
  // reader of that business, forever.
  it("lists the trail beside a row whose entity_id is text, not a uuid", async () => {
    await accountsService.renameAccount(biz.id, acct.expense, "Rent (renamed)", user.id);
    await db.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'settings.business.update', 'settings', 'business', '{"businessName":"Renamed Co"}')`,
      [biz.id, user.id],
    );

    const entries = await auditService.listAuditLog(biz.id, {});
    expect(entries.map((e) => e.action)).toContain("settings.business.update");
    expect(entries.map((e) => e.action)).toContain("account.renamed");
    // And the entity filter the audit tab's chip sends still narrows to it.
    const [settingsEntry] = await auditService.listAuditLog(biz.id, { entity: "settings" });
    expect(settingsEntry.action).toBe("settings.business.update");
  });

  it("still resolves an account row's live labels once a non-uuid row exists", async () => {
    await db.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'settings.mfa_policy.update', 'settings', 'mfa.policy', '{"requireForManagers":true}')`,
      [biz.id, user.id],
    );
    await accountsService.reparentAccount(biz.id, acct.expense, acct.cash, user.id);

    const [entry] = await auditService.listAuditLog(biz.id, { entity: "account", entityId: acct.expense });
    expect(entry.accountBeforeParentLabel).toBe("5000 — Expenses");
    expect(entry.accountAfterParentLabel).toBe("1100 — Cash");
  });
});
