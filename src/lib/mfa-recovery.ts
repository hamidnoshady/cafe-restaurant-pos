/**
 * Phase 24 Wave 2 — single-use recovery codes.
 *
 * The spec calls these mandatory rather than a nicety, and the reason is
 * narrow and concrete: if the only super-admin loses the phone that holds
 * their second factor, nothing in the product can let them back in. Ten codes,
 * printed once, are the difference between "read one off the paper in the
 * safe" and "edit the production database".
 *
 * Shape follows the rest of the codebase's one-way secrets: the plaintext is
 * returned exactly once, from the call that mints it, and only a bcrypt hash
 * (cost 10, matching passwords and PINs) is ever stored — so a database dump
 * yields no usable code. Single use is enforced by stamping `used_at` rather
 * than deleting the row, so «۷ کد باقی مانده» stays answerable and an audit
 * can see that a recovery path was taken.
 *
 * The alphabet is Phase 23's ambiguity-free one (no O/0, no I/1) because these
 * codes exist to be read off paper by someone already having a bad day.
 */
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { PAIRING_CODE_ALPHABET, foldDigits } from "./code-alphabet";
import { query, withoutTenantScope } from "./db";

/** Ten, per the phase spec. Enough to survive a few uses without becoming a list nobody keeps. */
export const RECOVERY_CODE_COUNT = 10;

/** Characters of entropy per code: 10 × log2(32) = 50 bits, well past guessable. */
export const RECOVERY_CODE_LENGTH = 10;

/** Where the display hyphen goes — `ABCDE-FGHJK`. Cosmetic; never stored. */
const GROUP_SIZE = 5;

const BCRYPT_COST = 10;

/** Anything that can run a parameterised query — the pool, or a transaction client. */
interface Executor {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * One code's worth of characters, unbiased.
 *
 * `PAIRING_CODE_ALPHABET` is exactly 32 symbols, so `byte & 31` indexes it with
 * no modulo bias — the same trick pairing-codes.ts uses, for the same reason.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
    out += PAIRING_CODE_ALPHABET[bytes[i] & 31];
  }
  return `${out.slice(0, GROUP_SIZE)}-${out.slice(GROUP_SIZE)}`;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * Fold a typed code back to the form that was hashed.
 *
 * Users paste these with the hyphen, without it, in lower case, with a stray
 * space, and — on a Persian keyboard — with Persian digits that look nothing
 * like the ASCII ones that were printed. All of those are the same code, and a
 * recovery path that rejects a correct code on a technicality is not a
 * recovery path.
 */
export function normalizeRecoveryCode(raw: string): string {
  const folded = foldDigits(String(raw ?? "")).toUpperCase();
  const kept = [...folded].filter((ch) => PAIRING_CODE_ALPHABET.includes(ch)).join("");
  if (kept.length !== RECOVERY_CODE_LENGTH) return kept;
  return `${kept.slice(0, GROUP_SIZE)}-${kept.slice(GROUP_SIZE)}`;
}

/**
 * Mint a fresh set, replacing any the account still holds, and return the
 * plaintext — the only time it exists outside the user's hands.
 *
 * Replacing rather than appending is deliberate: a set is a set. Re-enrolling
 * invalidates the sheet of paper from last time, which is what someone
 * re-enrolling after losing a device actually wants.
 *
 * `executor` lets provisioning mint codes inside the transaction that creates
 * the business, so a rolled-back provision leaves no orphan codes behind.
 */
export async function issueRecoveryCodes(
  subjectRealm: string,
  subjectId: string,
  executor?: Executor,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  const hashes = await Promise.all(codes.map((code) => bcrypt.hash(code, BCRYPT_COST)));

  const run = async (exec: Executor) => {
    await exec.query(`DELETE FROM mfa_recovery_codes WHERE subject_realm = $1 AND subject_id = $2`, [
      subjectRealm,
      subjectId,
    ]);
    for (const hash of hashes) {
      await exec.query(
        `INSERT INTO mfa_recovery_codes (subject_realm, subject_id, code_hash) VALUES ($1, $2, $3)`,
        [subjectRealm, subjectId, hash],
      );
    }
  };

  if (executor) {
    await run(executor);
  } else {
    await withoutTenantScope("platform", () => run({ query: query as Executor["query"] }));
  }

  return codes;
}

/**
 * Spend a recovery code, if it is one.
 *
 * bcrypt gives no way to look a code up by value, so every unused hash for the
 * account is compared in turn — ten comparisons at cost 10 is a few hundred
 * milliseconds, which is both acceptable on a path taken once a year and
 * usefully hostile to guessing. The winning row is claimed with a conditional
 * `UPDATE … WHERE used_at IS NULL`, so two concurrent redemptions of the same
 * code can only ever have one winner.
 */
export async function consumeRecoveryCode(
  subjectRealm: string,
  subjectId: string,
  rawCode: string,
): Promise<boolean> {
  const code = normalizeRecoveryCode(rawCode);
  if (code.length === 0) return false;

  return withoutTenantScope("platform", async () => {
    const { rows } = await query<{ id: string; code_hash: string }>(
      `SELECT id, code_hash FROM mfa_recovery_codes
        WHERE subject_realm = $1 AND subject_id = $2 AND used_at IS NULL`,
      [subjectRealm, subjectId],
    );

    for (const row of rows) {
      if (!(await bcrypt.compare(code, row.code_hash))) continue;
      const claimed = await query(
        `UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
        [row.id],
      );
      return claimed.rows.length > 0;
    }
    return false;
  });
}

/** How many of the ten are still spendable — what the console and the enrolment screen report. */
export async function countRemainingRecoveryCodes(
  subjectRealm: string,
  subjectId: string,
): Promise<number> {
  const { rows } = await withoutTenantScope("platform", () =>
    query<{ count: string }>(
      `SELECT count(*) FROM mfa_recovery_codes
        WHERE subject_realm = $1 AND subject_id = $2 AND used_at IS NULL`,
      [subjectRealm, subjectId],
    ),
  );
  return Number(rows[0]?.count ?? 0);
}
