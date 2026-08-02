/**
 * Phase 20 Wave 4 — device binding: the DB-touching half (not unit-tested
 * directly, per repo convention — see employee-service.ts's header for why).
 *
 * A "paired device" is nothing more than a bearer token an owner/manager
 * mints once, from an already-authenticated dashboard session, for the
 * terminal they're sitting at (src/app/api/devices/route.ts). Every
 * business-facing effect of pairing is a narrowing, never a widening: an
 * unpaired terminal (no token, or a token that no longer resolves) behaves
 * exactly like Wave 3 left it — every eligible employee's webauthn option is
 * offered everywhere. A paired terminal additionally lets the login picker
 * and the webauthn ceremony routes prefer/restrict to credentials actually
 * registered on it (see employee-service.ts's loginRoster/
 * beginWebauthnAuthentication `deviceId` parameter).
 */
import { getPool, query } from "./db";
import { generateDeviceToken, hashDeviceToken } from "./device";

export class DeviceError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

async function auditDevice(
  businessId: string,
  actorId: string | null,
  action: string,
  deviceId: string,
  payload?: unknown,
): Promise<void> {
  await getPool().query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
     VALUES ($1, $2, $3, 'device', $4, $5)`,
    [businessId, actorId, action, deviceId, JSON.stringify(payload ?? null)],
  );
}

export interface PosDevice {
  id: string;
  businessId: string;
  locationId: string | null;
  label: string;
  pairedBy: string | null;
  pairedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface DeviceRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  label: string;
  paired_by: string | null;
  paired_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

function toDevice(row: DeviceRow): PosDevice {
  return {
    id: row.id,
    businessId: row.business_id,
    locationId: row.location_id,
    label: row.label,
    pairedBy: row.paired_by,
    pairedAt: row.paired_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

/**
 * Mints a new device token — the plaintext is returned exactly once, the
 * same one-time-reveal shape as employee-service.ts's createSession and
 * Phase 19's api key issuance. `label` is what the settings UI and the
 * device list show, e.g. "صندوق ۱".
 */
export async function pairDevice(
  businessId: string,
  locationId: string | null,
  actorId: string | null,
  label: string,
): Promise<{ token: string; device: PosDevice }> {
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new DeviceError("invalid_label");
  }
  const { token, tokenHash } = generateDeviceToken();
  const { rows } = await query<DeviceRow>(
    `INSERT INTO pos_devices (business_id, location_id, label, token_hash, paired_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, business_id, location_id, label, paired_by, paired_at, last_seen_at, revoked_at`,
    [businessId, locationId, trimmed, tokenHash, actorId],
  );
  const device = toDevice(rows[0]);
  await auditDevice(businessId, actorId, "device.paired", device.id, { label: trimmed });
  return { token, device };
}

export async function listDevices(businessId: string): Promise<PosDevice[]> {
  const { rows } = await query<DeviceRow>(
    `SELECT id, business_id, location_id, label, paired_by, paired_at, last_seen_at, revoked_at
       FROM pos_devices
      WHERE business_id = $1
      ORDER BY paired_at DESC`,
    [businessId],
  );
  return rows.map(toDevice);
}

/**
 * Revokes a device and, since it can no longer be trusted, every
 * still-active session that was opened from it — the same
 * "revocation takes effect immediately" property Wave 2 gave
 * employee_sessions itself. Does not touch webauthn credentials registered
 * from this device: the device token narrows a public UI's choices, it is
 * never what proves the credential's own asymmetric keypair, so losing the
 * device record doesn't compromise (and revoking it doesn't need to
 * invalidate) the credential itself.
 */
export async function revokeDevice(
  deviceId: string,
  businessId: string,
  actorId: string | null,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `UPDATE pos_devices
          SET revoked_at = now()
        WHERE id = $1 AND business_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [deviceId, businessId],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      throw new DeviceError("device_not_found", 404);
    }
    await client.query(
      `UPDATE employee_sessions
          SET revoked_at = now()
        WHERE device_id = $1 AND business_id = $2 AND revoked_at IS NULL`,
      [deviceId, businessId],
    );
    await client.query(
      `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, 'device.revoked', 'device', $3, $4)`,
      [businessId, actorId, deviceId, JSON.stringify(null)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolves a presented device token to a device id, or null if it's absent,
 * unrecognised, or revoked — callers treat null exactly like "no device was
 * ever paired here" (see the module doc above), never as an error. Runs
 * inside the caller's own tenant scope (the business is already known by the
 * time any caller has one — resolveLoginBusinessId or an authenticated
 * session), so this needs no tenant-scope bypass of its own.
 */
export async function resolveDeviceId(
  token: string | null | undefined,
  businessId: string,
): Promise<string | null> {
  if (!token) return null;
  const tokenHash = hashDeviceToken(token);
  const { rows } = await query<{ id: string }>(
    `UPDATE pos_devices
        SET last_seen_at = now()
      WHERE token_hash = $1 AND business_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [tokenHash, businessId],
  );
  return rows[0]?.id ?? null;
}
