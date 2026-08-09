/**
 * The local install's half of desktop pairing: replay a PairingSnapshot into
 * an empty database.
 *
 * Bypassed (`platform`) throughout for the same reason `provisionBusiness` is:
 * it creates the tenant that scoping would otherwise require to already
 * exist. One transaction, so a partial pairing is impossible — either the
 * whole business lands or the database stays empty and the owner can retry
 * with a fresh code.
 *
 * Every id is inserted verbatim from the snapshot. That is the point: the
 * laptop and the server share a business_id, location_id and user ids, which
 * is what makes Phase 11's sync_events replay in both directions afterwards.
 *
 * DB-touching, so per repo convention no direct unit test — see
 * integration/pairing.integration.test.ts.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, withoutTenantScope } from "./db";
import type { PairingSnapshot } from "./pairing-snapshot";
import { SETTING_KEYS } from "./settings";

export interface AppliedSnapshot {
  businessId: string;
  businessSlug: string;
  locationId: string;
  ownerUserId: string;
  ownerName: string;
  ownerPlatformUserId: string | null;
}

export async function applyPairingSnapshot(
  snapshot: PairingSnapshot,
  remoteUrl: string,
): Promise<AppliedSnapshot> {
  return withoutTenantScope("platform", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO businesses (id, name, slug, timezone) VALUES ($1, $2, $3, $4)`,
        [
          snapshot.business.id,
          snapshot.business.name,
          snapshot.business.slug,
          snapshot.business.timezone,
        ],
      );

      await client.query(
        `INSERT INTO locations (id, business_id, name, address, phone, timezone)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          snapshot.location.id,
          snapshot.business.id,
          snapshot.location.name,
          snapshot.location.address,
          snapshot.location.phone,
          snapshot.location.timezone,
        ],
      );

      const ownerIds = await insertUsers(client, snapshot);
      await insertAccounts(client, snapshot);
      await insertMenu(client, snapshot);
      await insertSettings(client, snapshot, remoteUrl);
      await insertFeatures(client, snapshot);

      await client.query("COMMIT");
      return {
        businessId: snapshot.business.id,
        businessSlug: snapshot.business.slug,
        locationId: snapshot.location.id,
        ...ownerIds,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });
}

/**
 * Recreate memberships and, where one existed online, the global identity
 * behind them — so the owner signs in on the laptop with the same email and
 * password they use on the platform. Credential hashes are inserted as-is;
 * no plaintext ever crossed the wire.
 */
async function insertUsers(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<{
  ownerUserId: string;
  ownerName: string;
  ownerPlatformUserId: string | null;
}> {
  let ownerUserId = "";
  let ownerName = "";
  let ownerPlatformUserId: string | null = null;

  for (const user of snapshot.users) {
    let platformUserId: string | null = null;
    if (user.platformUserEmail && user.platformUserPasswordHash) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO platform_users (email, password_hash, full_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id`,
        [
          user.platformUserEmail,
          user.platformUserPasswordHash,
          user.platformUserFullName ?? user.fullName,
        ],
      );
      platformUserId = rows[0].id;
    }

    await client.query(
      `INSERT INTO users
         (id, business_id, platform_user_id, location_id, role, full_name, email,
          password_hash, pin_hash, permissions)
       VALUES ($1, $2, $3, NULL, $4::user_role, $5, $6, $7, $8, $9)`,
      [
        user.id,
        snapshot.business.id,
        platformUserId,
        user.role,
        user.fullName,
        user.email,
        user.passwordHash,
        user.pinHash,
        JSON.stringify(user.permissions ?? {}),
      ],
    );

    // Only assignments naming the branch this install actually holds; a
    // multi-branch business pairs one laptop per branch.
    for (const locationId of user.locationIds) {
      if (locationId !== snapshot.location.id) continue;
      await client.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [user.id, locationId],
      );
    }

    if (user.role === "owner" && !ownerUserId) {
      ownerUserId = user.id;
      ownerName = user.fullName;
      ownerPlatformUserId = platformUserId;
    }
  }

  return { ownerUserId, ownerName, ownerPlatformUserId };
}

/** Parents before children, resolving parent_id from a code→id map built as we go. */
async function insertAccounts(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<void> {
  const idByCode = new Map<string, string>();
  const pending = [...snapshot.accounts];
  let guard = pending.length + 1;
  while (pending.length > 0 && guard > 0) {
    guard -= 1;
    const ready = pending.filter(
      (a) => !a.parentCode || idByCode.has(a.parentCode),
    );
    // A snapshot whose parent chain can't be resolved (a cycle, or a parent
    // that was inactive and so never travelled) would loop forever; treat the
    // remaining rows as roots rather than hanging the pairing.
    const batch = ready.length > 0 ? ready : [...pending];
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
      const chunk = batch.slice(i, i + CHUNK_SIZE);
      const values: string[] = [];
      const args: any[] = [];
      let offset = 1;
      for (const account of chunk) {
        values.push(`($${offset}, $${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::account_type)`);
        args.push(
          account.id,
          snapshot.business.id,
          account.parentCode
            ? (idByCode.get(account.parentCode) ?? null)
            : null,
          account.code,
          account.name,
          account.type,
        );
        offset += 6;
      }
      if (values.length > 0) {
        await client.query(
          `INSERT INTO accounts (id, business_id, parent_id, code, name, type) VALUES ${values.join(", ")}`,
          args,
        );
      }
      for (const account of chunk) {
        idByCode.set(account.code, account.id);
        pending.splice(pending.indexOf(account), 1);
      }
    }
  }
}

async function insertMenu(client: PoolClient, snapshot: PairingSnapshot): Promise<void> {
  if (snapshot.menu.categories.length > 0) {
    await client.query(
      `INSERT INTO menu_categories (id, location_id, name, sort_order, is_active)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::integer[], $5::boolean[])`,
      [
        snapshot.menu.categories.map((c) => c.id),
        snapshot.menu.categories.map(() => snapshot.location.id),
        snapshot.menu.categories.map((c) => c.name),
        snapshot.menu.categories.map((c) => c.sortOrder),
        snapshot.menu.categories.map((c) => c.isActive),
      ]
    );
  }

  if (snapshot.menu.items.length > 0) {
    await client.query(
      `INSERT INTO menu_items
         (id, location_id, category_id, name, description, sku, price, image_url, is_active, sort_order)
       SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[], $9::boolean[], $10::integer[])`,
      [
        snapshot.menu.items.map((i) => i.id),
        snapshot.menu.items.map(() => snapshot.location.id),
        snapshot.menu.items.map((i) => i.categoryId),
        snapshot.menu.items.map((i) => i.name),
        snapshot.menu.items.map((i) => i.description),
        snapshot.menu.items.map((i) => i.sku),
        snapshot.menu.items.map((i) => i.price),
        snapshot.menu.items.map((i) => i.imageUrl),
        snapshot.menu.items.map((i) => i.isActive),
        snapshot.menu.items.map((i) => i.sortOrder),
      ]
    );
  }
}

/**
 * The snapshot's own settings, plus three this side owns:
 *
 *   - deployment.mode      — 'connected', stamped with the pairing time
 *   - server_sync.config   — the token the snapshot delivered, pointed at the
 *                            server that issued it, left disabled so the owner
 *                            turns sync on deliberately
 *   - setup.progress       — marked complete, because the configuration this
 *                            wizard would have collected is exactly what just
 *                            arrived
 */
async function insertSettings(
  client: PoolClient,
  snapshot: PairingSnapshot,
  remoteUrl: string,
): Promise<void> {
  const pairedAt = new Date().toISOString();

  if (snapshot.settings.length > 0) {
    const keys = snapshot.settings.map((s) => s.key);
    const values = snapshot.settings.map((s) => JSON.stringify(s.value));

    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       SELECT $1, NULL, k, v::jsonb
       FROM unnest($2::text[], $3::text[]) AS t(k, v)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [snapshot.business.id, keys, values],
    );
  }

  const owned: Array<[string, unknown]> = [
    [SETTING_KEYS.deploymentMode, { mode: "connected", pairedAt }],
    [
      SETTING_KEYS.serverSyncConfig,
      { remoteUrl, token: snapshot.syncToken, enabled: false, batchSize: 100 },
    ],
    [
      SETTING_KEYS.wizardProgress,
      { steps: { paired: pairedAt }, completedAt: pairedAt },
    ],
  ];

  if (owned.length > 0) {
    const keys = owned.map(([k]) => k);
    const values = owned.map(([_, v]) => JSON.stringify(v));

    await client.query(
      `INSERT INTO settings (business_id, location_id, key, value)
       SELECT $1, NULL, k, v::jsonb
       FROM unnest($2::text[], $3::text[]) AS t(k, v)
       ON CONFLICT (business_id, location_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [snapshot.business.id, keys, values],
    );
  }

  // The bearer token this install will present to the server. Stored hashed,
  // exactly as setServerSyncConfig would — inlined here because that helper
  // runs its own query() outside this transaction, and a half-applied pairing
  // must be impossible.
  await client.query(
    `INSERT INTO server_sync_tokens (business_id, token_hash, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (business_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, updated_at = now()`,
    [
      snapshot.business.id,
      createHash("sha256").update(snapshot.syncToken).digest("hex"),
    ],
  );
}

/**
 * Pin every flag the snapshot reported, so the laptop shows exactly what the
 * online business shows. Written as overrides rather than trusting local
 * defaults, because the two sides' catalogue defaults could diverge across
 * versions.
 */
async function insertFeatures(
  client: PoolClient,
  snapshot: PairingSnapshot,
): Promise<void> {
  const entries = Object.entries(snapshot.features);
  if (entries.length === 0) return;

  const keys = entries.map(([k]) => k);
  const vals = entries.map(([, v]) => v);

  await client.query(
    `INSERT INTO business_features (business_id, flag_key, enabled)
     SELECT $1, input.key, input.enabled
     FROM (SELECT unnest($2::text[]) AS key, unnest($3::boolean[]) AS enabled) AS input
     WHERE EXISTS (SELECT 1 FROM feature_flags WHERE key = input.key)
     ON CONFLICT (business_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [snapshot.business.id, keys, vals],
  );
}
