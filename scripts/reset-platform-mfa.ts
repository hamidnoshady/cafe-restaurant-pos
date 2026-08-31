/**
 * Phase 24 Wave 2 — the named escape hatch for a locked-out super-admin.
 *
 * There is no role above a platform admin, so there is nobody to press a
 * "reset their 2FA" button on their behalf. The phase spec names two ways back
 * into a console whose second factor is gone: one of the ten recovery codes,
 * and this script — run on the box itself, by whoever holds shell on it, which
 * is the only remaining authority once the phone is at the bottom of a river.
 *
 * What it does: deletes every `mfa_enrolments`, `mfa_challenges` and unspent
 * `mfa_recovery_codes` row for one admin, and stamps a fresh grace window so
 * the next login signs them in with a nag rather than a hard gate. It does NOT
 * touch the password, and it does not disable the requirement — the admin has
 * MFA_GRACE_DAYS_PLATFORM days to enrol again, and then the gate returns.
 *
 * Deliberately narrow: one email, named explicitly. A flag that reset every
 * admin at once would turn a lost phone into a platform-wide 2FA outage, and
 * would be the single most attractive line in this repository to an attacker
 * who has already reached a shell.
 *
 * Usage:
 *   npx tsx scripts/reset-platform-mfa.ts ops@example.com
 *   PLATFORM_ADMIN_EMAIL=ops@example.com npx tsx scripts/reset-platform-mfa.ts
 *
 * Add `--list` to see who is enrolled without changing anything.
 */
import "dotenv/config";
import { Client } from "pg";
import { MFA_GRACE_DAYS_PLATFORM } from "../src/lib/mfa";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const listOnly = args.includes("--list");
  const email = (args.find((a) => !a.startsWith("--")) ?? process.env.PLATFORM_ADMIN_EMAIL ?? "")
    .trim()
    .toLowerCase();

  if (!listOnly && !email) {
    console.error("Usage: npx tsx scripts/reset-platform-mfa.ts <admin-email>");
    console.error("       npx tsx scripts/reset-platform-mfa.ts --list");
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // The MFA tables are global identity tables with no business_id (they join
    // EXEMPT_TABLES for the same reason auth_login_attempts does), but set the
    // bypass GUC anyway in case this runs as the unprivileged app role.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    if (listOnly) {
      const { rows } = await client.query<{
        email: string;
        role: string;
        methods: string[] | null;
        grace_until: Date | null;
        recovery_left: string;
      }>(
        `SELECT a.email::text AS email,
                a.role::text AS role,
                (SELECT array_agg(e.method ORDER BY e.method)
                   FROM mfa_enrolments e
                  WHERE e.subject_realm = 'platform_admin' AND e.subject_id = a.id) AS methods,
                g.grace_until,
                (SELECT count(*) FROM mfa_recovery_codes r
                  WHERE r.subject_realm = 'platform_admin' AND r.subject_id = a.id
                    AND r.used_at IS NULL) AS recovery_left
           FROM platform_admins a
           LEFT JOIN mfa_grace_periods g
             ON g.subject_realm = 'platform_admin' AND g.subject_id = a.id
          WHERE a.is_active
          ORDER BY a.email`,
      );
      if (rows.length === 0) {
        console.log("No active platform admins.");
        return;
      }
      for (const r of rows) {
        const methods = r.methods?.length ? r.methods.join("+") : "none";
        const grace = r.grace_until ? new Date(r.grace_until).toISOString() : "—";
        console.log(
          `${r.email}\trole=${r.role}\tmfa=${methods}\tgrace_until=${grace}\trecovery_codes_left=${r.recovery_left}`,
        );
      }
      return;
    }

    const { rows: admins } = await client.query<{ id: string; full_name: string; is_active: boolean }>(
      `SELECT id, full_name, is_active FROM platform_admins WHERE email = $1`,
      [email],
    );
    const admin = admins[0];
    if (!admin) {
      console.error(`No platform admin with email ${email}.`);
      process.exit(1);
    }
    if (!admin.is_active) {
      // Resetting a disabled admin's second factor would be a confusing no-op:
      // they cannot sign in whatever their MFA state is. Say so rather than
      // reporting success.
      console.error(`Platform admin ${email} is disabled; re-enable them first.`);
      process.exit(1);
    }

    // One transaction: an interrupted reset that dropped the enrolment but not
    // the grace stamp would leave the admin hard-gated with no factor at all —
    // exactly the state this script exists to get them out of.
    await client.query("BEGIN");
    const enrolments = await client.query(
      `DELETE FROM mfa_enrolments WHERE subject_realm = 'platform_admin' AND subject_id = $1`,
      [admin.id],
    );
    await client.query(
      `DELETE FROM mfa_challenges WHERE subject_realm = 'platform_admin' AND subject_id = $1`,
      [admin.id],
    );
    const codes = await client.query(
      `DELETE FROM mfa_recovery_codes WHERE subject_realm = 'platform_admin' AND subject_id = $1`,
      [admin.id],
    );
    const { rows: grace } = await client.query<{ grace_until: Date }>(
      `INSERT INTO mfa_grace_periods (subject_realm, subject_id, grace_until)
       VALUES ('platform_admin', $1, now() + interval '1 day' * $2)
       ON CONFLICT (subject_realm, subject_id)
       DO UPDATE SET grace_until = now() + interval '1 day' * $2
       RETURNING grace_until`,
      [admin.id, MFA_GRACE_DAYS_PLATFORM],
    );

    // A reset is a privileged act on the most powerful account in the product,
    // so it leaves the same trail a console action would — with a null
    // platform_admin_id, because the authority here is shell access to the box,
    // not a signed-in admin.
    await client.query(
      `INSERT INTO platform_audit_log (platform_admin_id, action, entity, entity_id, payload)
       VALUES (NULL, 'platform_admin.mfa_reset', 'platform_admin', $1, $2)`,
      [
        admin.id,
        JSON.stringify({
          email,
          via: "scripts/reset-platform-mfa.ts",
          enrolmentsRemoved: enrolments.rowCount ?? 0,
          recoveryCodesRemoved: codes.rowCount ?? 0,
        }),
      ],
    );
    await client.query("COMMIT");

    console.log(`Reset two-factor authentication for ${email} (${admin.full_name}).`);
    console.log(`  enrolments removed:    ${enrolments.rowCount ?? 0}`);
    console.log(`  recovery codes removed:${codes.rowCount ?? 0}`);
    console.log(
      `  grace until:           ${grace[0] ? new Date(grace[0].grace_until).toISOString() : "unknown"}`,
    );
    console.log("They can now sign in with their password and will be prompted to enrol again.");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
