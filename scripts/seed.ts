/**
 * Seeds the minimum data needed to log in:
 *   - one business + one location
 *   - one Owner user (email/password from SEED_OWNER_* env vars)
 *   - one sample Cashier with PIN 1234 (to exercise PIN quick-login)
 *
 * Idempotent: re-running skips anything that already exists.
 *
 * Usage: npm run db:seed
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { Client } from "pg";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const email = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
  const password = process.env.SEED_OWNER_PASSWORD ?? "owner1234";
  const name = process.env.SEED_OWNER_NAME ?? "مالک نمونه";

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query("BEGIN");

    let businessId: string;
    const existingBusiness = await client.query("SELECT id FROM businesses LIMIT 1");
    if (existingBusiness.rowCount) {
      businessId = existingBusiness.rows[0].id;
      console.log("Business already exists, reusing.");
    } else {
      const res = await client.query(
        "INSERT INTO businesses (name) VALUES ($1) RETURNING id",
        ["کافه نمونه"],
      );
      businessId = res.rows[0].id;
      console.log("Created business «کافه نمونه».");
    }

    let locationId: string;
    const existingLocation = await client.query(
      "SELECT id FROM locations WHERE business_id = $1 LIMIT 1",
      [businessId],
    );
    if (existingLocation.rowCount) {
      locationId = existingLocation.rows[0].id;
      console.log("Location already exists, reusing.");
    } else {
      const res = await client.query(
        "INSERT INTO locations (business_id, name) VALUES ($1, $2) RETURNING id",
        [businessId, "شعبه مرکزی"],
      );
      locationId = res.rows[0].id;
      console.log("Created location «شعبه مرکزی».");
    }

    const existingOwner = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );
    if (existingOwner.rowCount) {
      console.log(`Owner ${email} already exists, skipping.`);
    } else {
      await client.query(
        `INSERT INTO users (business_id, role, full_name, email, password_hash)
         VALUES ($1, 'owner', $2, $3, $4)`,
        [businessId, name, email, await bcrypt.hash(password, 10)],
      );
      console.log(`Created owner ${email} (password from SEED_OWNER_PASSWORD).`);
    }

    const existingCashier = await client.query(
      "SELECT id FROM users WHERE business_id = $1 AND role = 'cashier' LIMIT 1",
      [businessId],
    );
    if (existingCashier.rowCount) {
      console.log("Sample cashier already exists, skipping.");
    } else {
      await client.query(
        `INSERT INTO users (business_id, location_id, role, full_name, pin_hash)
         VALUES ($1, $2, 'cashier', $3, $4)`,
        [businessId, locationId, "صندوق‌دار نمونه", await bcrypt.hash("1234", 10)],
      );
      console.log("Created sample cashier with PIN 1234.");
    }

    await client.query("COMMIT");
    console.log("Seed complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
