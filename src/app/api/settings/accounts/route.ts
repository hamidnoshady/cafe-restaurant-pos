import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getPool, query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import {
  FNB_COA_TEMPLATE,
  nextAccountLevel,
  validateAccounts,
  type AccountLevel,
  type TemplateAccount,
} from "@/lib/coa-template";

/** Chart of accounts management after initial setup. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  const { rows: existing } = await query(
    `SELECT a.id, a.code, a.name, a.type, p.code AS parent_code
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.business_id = $1 ORDER BY a.code`,
    [session.businessId],
  );
  return NextResponse.json({ template: FNB_COA_TEMPLATE, existing });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.accountsEdit);
  if (error) return error;

  let body: { accounts?: TemplateAccount[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const accounts = (Array.isArray(body.accounts) ? body.accounts : []).map((account) => ({
    code: String(account.code ?? "").trim(),
    name: String(account.name ?? "").trim(),
    type: account.type,
    parentCode: account.parentCode ? String(account.parentCode).trim() : undefined,
    isContra: Boolean(account.isContra),
  }));
  const messages = validateAccounts(accounts);
  if (messages.length > 0) {
    return NextResponse.json({ error: "invalid_accounts", messages }, { status: 400 });
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows: used } = await client.query(
      `SELECT 1 FROM journal_lines jl
        JOIN accounts a ON a.id = jl.account_id
       WHERE a.business_id = $1 LIMIT 1`,
      [session.businessId],
    );
    if (used.length > 0) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "accounts_in_use" }, { status: 409 });
    }
    await client.query("DELETE FROM accounts WHERE business_id = $1", [session.businessId]);

    const idByCode = new Map<string, string>();
    const levelByCode = new Map<string, AccountLevel>();
    const pending = [...accounts];
    while (pending.length > 0) {
      const ready = pending.filter((account) => !account.parentCode || idByCode.has(account.parentCode));
      if (ready.length === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "invalid_accounts", messages: ["ساختار والد/فرزند حساب‌ها حلقه دارد."] }, { status: 400 });
      }
      for (const account of ready) {
        const parentLevel = account.parentCode ? (levelByCode.get(account.parentCode) ?? null) : null;
        const level = nextAccountLevel(parentLevel);
        if (!level) {
          await client.query("ROLLBACK");
          return NextResponse.json(
            { error: "invalid_accounts", messages: ["ساختار حساب‌ها از سطح «تفصیلی» عمیق‌تر است."] },
            { status: 400 },
          );
        }
        const result = await client.query(
          `INSERT INTO accounts (business_id, parent_id, code, name, type, level, is_contra)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            session.businessId,
            account.parentCode ? idByCode.get(account.parentCode) : null,
            account.code,
            account.name,
            account.type,
            level,
            account.isContra,
          ],
        );
        idByCode.set(account.code, result.rows[0].id);
        levelByCode.set(account.code, level);
        pending.splice(pending.indexOf(account), 1);
      }
    }
    await client.query("COMMIT");
  } catch (cause) {
    await client.query("ROLLBACK");
    throw cause;
  } finally {
    client.release();
  }
  return NextResponse.json({ ok: true, created: accounts.length });
});
