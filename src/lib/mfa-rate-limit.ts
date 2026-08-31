import { query, withoutTenantScope } from "./db";
import { identityKeyFor } from "./login-lockout-service";

export async function checkMfaChallengeRateLimit(email: string): Promise<{ allowed: boolean; retryAfterMs: number }> {
  const identityKey = await identityKeyFor(email);
  const now = new Date();

  const { rows } = await withoutTenantScope("platform", () => 
    query<{ created_at: Date }>(
      `SELECT created_at FROM auth_login_attempts 
       WHERE realm = 'mfa_challenge' AND identity_key = $1
       ORDER BY created_at DESC LIMIT 20`,
      [identityKey]
    )
  );

  // one per 60 seconds
  if (rows.length > 0) {
    const last = new Date(rows[0].created_at).getTime();
    if (now.getTime() - last < 60_000) {
      return { allowed: false, retryAfterMs: 60_000 - (now.getTime() - last) };
    }
  }

  // five per hour
  const lastHour = rows.filter(r => now.getTime() - new Date(r.created_at).getTime() < 3600_000);
  if (lastHour.length >= 5) {
    const oldestInWindow = new Date(lastHour[4].created_at).getTime();
    return { allowed: false, retryAfterMs: 3600_000 - (now.getTime() - oldestInWindow) };
  }

  // twenty per day
  const lastDay = rows.filter(r => now.getTime() - new Date(r.created_at).getTime() < 86400_000);
  if (lastDay.length >= 20) {
    const oldestInWindow = new Date(lastDay[19].created_at).getTime();
    return { allowed: false, retryAfterMs: 86400_000 - (now.getTime() - oldestInWindow) };
  }

  return { allowed: true, retryAfterMs: 0 };
}

export async function recordMfaChallenge(email: string) {
  const identityKey = await identityKeyFor(email);
  await withoutTenantScope("platform", () => 
    query(
      `INSERT INTO auth_login_attempts (realm, identity_key, outcome) VALUES ('mfa_challenge', $1, 'success')`,
      [identityKey]
    )
  );
}
