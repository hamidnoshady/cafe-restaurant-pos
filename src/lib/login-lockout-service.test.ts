/**
 * Regression cover for the lockout service's SQL seam.
 *
 * `auth_login_attempts` (migration 0070) stores the verdict in an `outcome`
 * column, while the shared `lockoutStatus` helper — which also serves the
 * employee-PIN realm off the audit log — speaks in `action`. The translation
 * between the two happens here, and getting it wrong is not a quiet bug: the
 * lockout check runs on the *successful* password path of all three login
 * routes, so a bad column name turns every correct credential into an HTTP
 * 500 and disables the brute-force control at the same time.
 *
 * These tests assert against the SQL text on purpose. There is no cheaper
 * place to catch a column that does not exist — the failure otherwise only
 * surfaces against a real database, and only on the login path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkAuthLockout, recordAuthFailure, recordAuthSuccess, clearAuthLockout } from "./login-lockout-service";
import { PLATFORM_LOCKOUT_POLICY } from "./login-lockout";
import * as db from "./db";

vi.mock("./db", () => ({ query: vi.fn() }));

/** The columns migration 0070 actually defines. */
const COLUMNS = ["id", "realm", "identity_key", "outcome", "created_at"];

function sqlOf(call: unknown[]): string {
  return String(call[0]).replace(/\s+/g, " ").trim();
}

/** Bare column references in a statement, minus SQL keywords and literals. */
function referencedColumns(sql: string): string[] {
  const stripped = sql.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const words = stripped.match(/\b[a-z_][a-z0-9_]*\b/gi) ?? [];
  const keywords = new Set([
    "select", "from", "where", "order", "by", "limit", "and", "or", "as", "desc", "asc",
    "insert", "into", "values", "auth_login_attempts", "null", "not", "in",
  ]);
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => !keywords.has(w)))];
}

describe("login-lockout-service", () => {
  beforeEach(() => {
    vi.mocked(db.query).mockReset();
    process.env.LOGIN_ATTEMPT_PEPPER = "test-pepper";
  });

  it("reads the lockout streak from the outcome column that actually exists", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);

    await checkAuthLockout("platform_admin", "owner@example.com", PLATFORM_LOCKOUT_POLICY);

    const sql = sqlOf(vi.mocked(db.query).mock.calls[0]);
    expect(sql).toMatch(/\boutcome\b/);
    // `action` is the audit-log vocabulary, not this table's. Selecting it
    // throws "column does not exist" on every correct-password login.
    expect(sql).not.toMatch(/\baction\b/);
    for (const column of referencedColumns(sql)) {
      expect(COLUMNS, `unknown column "${column}" in lockout query`).toContain(column);
    }
  });

  it("maps outcome rows onto the action vocabulary lockoutStatus expects", async () => {
    const now = new Date();
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        { outcome: "failed", createdAt: now },
        { outcome: "failed", createdAt: new Date(now.getTime() - 1_000) },
        { outcome: "failed", createdAt: new Date(now.getTime() - 2_000) },
      ],
    } as never);

    const status = await checkAuthLockout("platform_admin", "owner@example.com", PLATFORM_LOCKOUT_POLICY);
    expect(status.locked).toBe(true);
    expect(status.failedCount).toBe(3);
  });

  it("lets a success break the streak", async () => {
    const now = new Date();
    vi.mocked(db.query).mockResolvedValue({
      rows: [
        { outcome: "success", createdAt: now },
        { outcome: "failed", createdAt: new Date(now.getTime() - 1_000) },
        { outcome: "failed", createdAt: new Date(now.getTime() - 2_000) },
      ],
    } as never);

    const status = await checkAuthLockout("platform_admin", "owner@example.com", PLATFORM_LOCKOUT_POLICY);
    expect(status.locked).toBe(false);
    expect(status.failedCount).toBe(0);
  });

  it("scopes every read and write to one realm and identity", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);

    await checkAuthLockout("directory", "owner@example.com", PLATFORM_LOCKOUT_POLICY);
    const [, readParams] = vi.mocked(db.query).mock.calls[0];
    expect((readParams as unknown[])[0]).toBe("directory");
    // The identity is peppered, never the raw address.
    expect((readParams as unknown[])[1]).not.toBe("owner@example.com");
    expect((readParams as unknown[])[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records each outcome against the table's CHECK constraint values", async () => {
    vi.mocked(db.query).mockResolvedValue({ rows: [] } as never);

    await recordAuthFailure("tenant_password", "owner@example.com");
    await recordAuthSuccess("tenant_password", "owner@example.com");
    await clearAuthLockout("tenant_password", "owner@example.com");

    const statements = vi.mocked(db.query).mock.calls.map((call) => sqlOf(call));
    expect(statements[0]).toContain("'failed'");
    expect(statements[1]).toContain("'success'");
    expect(statements[2]).toContain("'unlocked'");
    for (const sql of statements) {
      expect(sql).toContain("outcome");
      for (const column of referencedColumns(sql)) {
        expect(COLUMNS, `unknown column "${column}" in write`).toContain(column);
      }
    }
  });
});
