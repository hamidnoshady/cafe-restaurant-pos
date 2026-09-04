/**
 * Phase 15 — create (or promote) the first super-admin.
 *
 * The platform console is a separate auth realm with no self-service door: the
 * only way the first `platform_admins` row comes into existence is here, run by
 * whoever operates the deployment. After that, an owner-role admin can add
 * others from the console.
 *
 * Idempotent on email: re-running updates the existing admin's password, name,
 * and role rather than erroring, so it doubles as a "reset my platform login".
 *
 * Usage:
 *   PLATFORM_ADMIN_EMAIL=ops@example.com \
 *   PLATFORM_ADMIN_PASSWORD=... \
 *   PLATFORM_ADMIN_NAME="مدیر ارشد" \
 *   PLATFORM_ADMIN_ROLE=owner \
 *   npm run db:platform-admin
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { BCRYPT_COST } from "../src/lib/password-hashing";
import { Client } from "pg";

const VALID_ROLES = ["support", "engineer", "owner"] as const;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const email = (process.env.PLATFORM_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? "";
  const name = process.env.PLATFORM_ADMIN_NAME ?? "Platform Owner";
  const role = (process.env.PLATFORM_ADMIN_ROLE ?? "owner").trim();

  if (!email || !password) {
    console.error("Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("PLATFORM_ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }
  if (!VALID_ROLES.includes(role as (typeof VALID_ROLES)[number])) {
    console.error(`PLATFORM_ADMIN_ROLE must be one of: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // platform_admins is not RLS-protected (see migration 0021), so no scope
    // juggling is needed; still, set the bypass GUC in case this runs as the
    // unprivileged app role.
    await client.query("SELECT set_config('app.rls_bypass', 'on', true)");

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const { rows } = await client.query<{ id: string; created: boolean }>(
      `INSERT INTO platform_admins (email, password_hash, full_name, role)
       VALUES ($1, $2, $3, $4::platform_admin_role)
       ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             full_name = EXCLUDED.full_name,
             role = EXCLUDED.role,
             is_active = true,
             updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [email, passwordHash, name, role],
    );

    console.log(
      rows[0].created
        ? `Created platform admin ${email} (role ${role}).`
        : `Updated existing platform admin ${email} (role ${role}, password reset).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
