/**
 * Phase 16 — chart of accounts customisation.
 *
 * `accounts` has carried `parent_id` and `is_active` since Phase 1 — sub-
 * accounts and archival needed no schema change, only the CRUD this file
 * provides plus the guards that make them safe: a well-known code (anything
 * in coa-template.ts's WELL_KNOWN_CODES — auto-posting looks these up by
 * code, not id) can never be archived or deleted, and an account with any
 * postings against it (real or drafted) can only be archived, never deleted,
 * so history never goes missing. Archiving doesn't touch history either — a
 * trial balance or statement still shows every posting an archived account
 * ever received; it just stops being offered for new ones (manual-journal-
 * service's assertAccountsOwned filters is_active the same way the account
 * picker already did).
 */
import { query, getPool } from "./db";
import {
  ACCOUNT_TYPES,
  WELL_KNOWN_CODES,
  nextAccountLevel,
  type AccountLevel,
  type AccountType,
  type NormalBalance,
} from "./coa-template";
import type { PoolClient } from "pg";

export class AccountsError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

const WELL_KNOWN_CODE_SET = new Set<string>(Object.values(WELL_KNOWN_CODES));

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  parentCode: string | null;
  isActive: boolean;
  hasPostings: boolean;
  hasChildren: boolean;
  level: AccountLevel;
  normalBalance: NormalBalance;
  isContra: boolean;
}

export async function listAccounts(businessId: string): Promise<AccountRow[]> {
  const { rows } = await query<{
    id: string;
    code: string;
    name: string;
    type: AccountType;
    parent_id: string | null;
    parent_code: string | null;
    is_active: boolean;
    has_postings: boolean;
    has_children: boolean;
    level: AccountLevel;
    normal_balance: NormalBalance;
    is_contra: boolean;
  }>(
    `SELECT a.id, a.code, a.name, a.type, a.parent_id, p.code AS parent_code, a.is_active,
            EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.account_id = a.id) AS has_postings,
            EXISTS (SELECT 1 FROM accounts c WHERE c.parent_id = a.id) AS has_children,
            a.level, a.normal_balance, a.is_contra
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.business_id = $1
      ORDER BY a.code`,
    [businessId],
  );
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    type: r.type,
    parentId: r.parent_id,
    parentCode: r.parent_code,
    isActive: r.is_active,
    hasPostings: r.has_postings,
    hasChildren: r.has_children,
    level: r.level,
    normalBalance: r.normal_balance,
    isContra: r.is_contra,
  }));
}

async function findAccount(businessId: string, id: string) {
  const { rows } = await query<{ id: string; code: string; name: string; parent_id: string | null; level: AccountLevel }>(
    `SELECT id, code, name, parent_id, level FROM accounts WHERE business_id = $1 AND id = $2`,
    [businessId, id],
  );
  return rows[0] ?? null;
}

/**
 * §7.5's audit-trail question (issue #160, Phase 22 Wave 11) — reuses the
 * existing `audit_log` table (Phase 0/20) rather than a dedicated history
 * table: `accounts` itself stays current-state-only, and every
 * rename/reparent/archive is a row here instead, the same "current state +
 * an append-only log elsewhere" split every other audited entity
 * (branches, employees, devices) already uses.
 */
async function recordAccountAudit(
  businessId: string,
  actorId: string | null,
  action: "account.renamed" | "account.reparented" | "account.archived" | "account.reactivated",
  accountId: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'account', $4, $5)`,
    [businessId, actorId, action, accountId, payload ? JSON.stringify(payload) : null],
  );
}

/**
 * Walks a subtree top-down, recomputing each descendant's `level` from its
 * (already-updated) parent's — the cascade a reparent needs whenever the
 * moved account's own level changes. Throws `hierarchy_too_deep` if any
 * descendant would need to sit below تفصیلی, the deepest standard tier.
 */
async function cascadeDescendantLevels(
  client: PoolClient,
  businessId: string,
  rootId: string,
  rootLevel: AccountLevel,
): Promise<void> {
  let frontier: { id: string; level: AccountLevel }[] = [{ id: rootId, level: rootLevel }];
  while (frontier.length > 0) {
    const nextFrontier: { id: string; level: AccountLevel }[] = [];
    for (const node of frontier) {
      const { rows: children } = await client.query<{ id: string }>(
        `SELECT id FROM accounts WHERE business_id = $1 AND parent_id = $2`,
        [businessId, node.id],
      );
      if (children.length === 0) continue;
      const childLevel = nextAccountLevel(node.level);
      if (!childLevel) throw new AccountsError("hierarchy_too_deep", 409);
      for (const c of children) {
        await client.query(`UPDATE accounts SET level = $1 WHERE id = $2`, [childLevel, c.id]);
        nextFrontier.push({ id: c.id, level: childLevel });
      }
    }
    frontier = nextFrontier;
  }
}

/** Walks the parent chain of `candidateParentId`; throws if it ever reaches `accountId`. */
async function assertNoCycle(businessId: string, accountId: string, candidateParentId: string): Promise<void> {
  let current: string | null = candidateParentId;
  while (current) {
    if (current === accountId) throw new AccountsError("parent_cycle");
    const result: { rows: { parent_id: string | null }[] } = await query<{ parent_id: string | null }>(
      `SELECT parent_id FROM accounts WHERE business_id = $1 AND id = $2`,
      [businessId, current],
    );
    current = result.rows[0]?.parent_id ?? null;
  }
}

export async function createAccount(params: {
  businessId: string;
  code: string;
  name: string;
  type: string;
  parentId?: string | null;
  isContra?: boolean;
}): Promise<{ id: string }> {
  const code = params.code.trim();
  const name = params.name.trim();
  if (!code) throw new AccountsError("code_required");
  if (!name) throw new AccountsError("name_required");
  if (!ACCOUNT_TYPES.includes(params.type as AccountType)) throw new AccountsError("invalid_type");

  let level: AccountLevel = "group";
  if (params.parentId) {
    const parent = await findAccount(params.businessId, params.parentId);
    if (!parent) throw new AccountsError("parent_not_found");
    const computed = nextAccountLevel(parent.level);
    if (!computed) throw new AccountsError("parent_too_deep", 409);
    level = computed;
  }

  const { rows: existing } = await query(`SELECT 1 FROM accounts WHERE business_id = $1 AND code = $2`, [
    params.businessId,
    code,
  ]);
  if (existing.length > 0) throw new AccountsError("code_in_use", 409);

  const { rows } = await query<{ id: string }>(
    `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [params.businessId, params.parentId ?? null, code, name, params.type, level, params.isContra ?? false],
  );
  return { id: rows[0].id };
}

export async function renameAccount(
  businessId: string,
  id: string,
  name: string,
  actorId: string | null = null,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new AccountsError("name_required");
  const before = await findAccount(businessId, id);
  if (!before) throw new AccountsError("account_not_found", 404);
  const { rowCount } = await query(`UPDATE accounts SET name = $1 WHERE business_id = $2 AND id = $3`, [
    trimmed,
    businessId,
    id,
  ]);
  if (!rowCount) throw new AccountsError("account_not_found", 404);
  if (before.name !== trimmed) {
    await recordAccountAudit(businessId, actorId, "account.renamed", id, { before: before.name, after: trimmed });
  }
}

export async function reparentAccount(
  businessId: string,
  id: string,
  parentId: string | null,
  actorId: string | null = null,
): Promise<void> {
  const account = await findAccount(businessId, id);
  if (!account) throw new AccountsError("account_not_found", 404);

  let newLevel: AccountLevel;
  if (parentId) {
    if (parentId === id) throw new AccountsError("parent_cycle");
    const parent = await findAccount(businessId, parentId);
    if (!parent) throw new AccountsError("parent_not_found");
    await assertNoCycle(businessId, id, parentId);
    const computed = nextAccountLevel(parent.level);
    if (!computed) throw new AccountsError("parent_too_deep", 409);
    newLevel = computed;
  } else {
    newLevel = "group";
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE accounts SET parent_id = $1, level = $2 WHERE business_id = $3 AND id = $4`, [
      parentId,
      newLevel,
      businessId,
      id,
    ]);
    await cascadeDescendantLevels(client, businessId, id, newLevel);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (account.parent_id !== parentId) {
    await recordAccountAudit(businessId, actorId, "account.reparented", id, {
      beforeParentId: account.parent_id,
      afterParentId: parentId,
    });
  }
}

export async function setAccountActive(
  businessId: string,
  id: string,
  isActive: boolean,
  actorId: string | null = null,
): Promise<void> {
  const account = await findAccount(businessId, id);
  if (!account) throw new AccountsError("account_not_found", 404);
  if (!isActive && WELL_KNOWN_CODE_SET.has(account.code)) throw new AccountsError("well_known_account", 409);

  const { rowCount } = await query(`UPDATE accounts SET is_active = $1 WHERE business_id = $2 AND id = $3`, [
    isActive,
    businessId,
    id,
  ]);
  if (!rowCount) throw new AccountsError("account_not_found", 404);
  await recordAccountAudit(businessId, actorId, isActive ? "account.reactivated" : "account.archived", id);
}

/** Hard delete — only for an account that was never actually posted to. Otherwise, archive it. */
export async function deleteAccount(businessId: string, id: string): Promise<void> {
  const account = await findAccount(businessId, id);
  if (!account) throw new AccountsError("account_not_found", 404);
  if (WELL_KNOWN_CODE_SET.has(account.code)) throw new AccountsError("well_known_account", 409);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: postings } = await client.query(`SELECT 1 FROM journal_lines WHERE account_id = $1 LIMIT 1`, [id]);
    if (postings.length > 0) {
      await client.query("ROLLBACK");
      throw new AccountsError("account_has_postings", 409);
    }
    const { rows: draftLines } = await client.query(
      `SELECT 1 FROM journal_entry_draft_lines WHERE account_id = $1 LIMIT 1`,
      [id],
    );
    if (draftLines.length > 0) {
      await client.query("ROLLBACK");
      throw new AccountsError("account_has_draft_postings", 409);
    }
    const { rows: children } = await client.query(`SELECT 1 FROM accounts WHERE parent_id = $1 LIMIT 1`, [id]);
    if (children.length > 0) {
      await client.query("ROLLBACK");
      throw new AccountsError("account_has_children", 409);
    }
    const { rowCount } = await client.query(`DELETE FROM accounts WHERE business_id = $1 AND id = $2`, [
      businessId,
      id,
    ]);
    if (!rowCount) {
      await client.query("ROLLBACK");
      throw new AccountsError("account_not_found", 404);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
