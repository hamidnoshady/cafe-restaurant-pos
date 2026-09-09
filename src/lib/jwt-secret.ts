/**
 * Shared JWT_SECRET resolution for both auth realms (auth-edge.ts's tenant
 * sessions, platform-auth-edge.ts's platform sessions) — they sign with the
 * same env var (see platform-auth-edge.ts's own comment on why: one
 * deployment, one signing key, kept apart by cookie name and `realm` claim
 * instead), so the same validation applies to both.
 *
 * Phase 17 security review flagged, but deliberately did not act on, a gap
 * here: the only checks were "is it set" and "is it the placeholder", with
 * no floor on strength — `JWT_SECRET=x` passed silently. That was left as a
 * documented follow-up rather than auto-applied, specifically because
 * tightening it risked breaking a real deployment's CI or production
 * environment sight unseen. Approved and applied now: production refuses a
 * secret under 32 characters (256 bits, the usual HS256 floor), not just an
 * unset or placeholder one.
 */
import { jwtVerify } from "jose";

const PLACEHOLDER = "change-me-in-production";
const MIN_SECRET_LENGTH = 32;

export type SigningRealm = "tenant" | "platform" | "mfa" | "phone";

const cache = new Map<SigningRealm, Promise<Uint8Array>>();

/**
 * Validates and retrieves the base JWT_SECRET or specific override.
 */
function getBaseSecret(realm?: SigningRealm, envKeySuffix?: string): Uint8Array {
  let envKey = "JWT_SECRET";
  if (realm) envKey = `JWT_SECRET_${realm.toUpperCase()}`;
  if (envKeySuffix) envKey += envKeySuffix;
  
  const secret = process.env[envKey] || (envKeySuffix ? undefined : process.env.JWT_SECRET);
  const isProduction = process.env.NODE_ENV === "production";

  if (secret && secret !== PLACEHOLDER) {
    if (isProduction && secret.length < MIN_SECRET_LENGTH) {
      throw new Error(
        `JWT_SECRET is only ${secret.length} characters — at least ${MIN_SECRET_LENGTH} are required in ` +
          `production.`
      );
    }
    return new TextEncoder().encode(secret);
  }

  throw new Error(
    `JWT_SECRET must be set to a real secret before signing.`
  );
}

export async function getRealmSecret(realm: SigningRealm, previous: boolean = false): Promise<Uint8Array> {
  const cacheKey = `${realm}${previous ? "_prev" : ""}` as SigningRealm;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }
  const promise = (async () => {
    const override = process.env[`JWT_SECRET_${realm.toUpperCase()}${previous ? "_PREVIOUS" : ""}`];
    if (override) {
      return getBaseSecret(realm, previous ? "_PREVIOUS" : "");
    }
    const baseSecret = getBaseSecret(undefined, previous ? "_PREVIOUS" : "");
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      baseSecret.buffer as ArrayBuffer,
      "HKDF",
      false,
      ["deriveBits"]
    );
    const info = new TextEncoder().encode(`pos.jwt.${realm}.v1`);
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: info,
      },
      keyMaterial,
      256
    );
    return new Uint8Array(derivedBits);
  })();
  cache.set(cacheKey, promise);
  return promise;
}

/**
 * Every token this app mints is signed HS256 (see the `SignJWT` call sites), so
 * verification names that one algorithm rather than accepting whatever the
 * token's own header asks for.
 *
 * jose would not have allowed the classic RS256->HS256 confusion here anyway —
 * the key is raw secret bytes, and it refuses to verify an asymmetric alg
 * against one — but "the library happens to stop it" is a weaker guarantee than
 * saying which algorithm we accept, and it stops being true the day a realm is
 * given an asymmetric key.
 */
const ACCEPTED_ALGORITHMS = ["HS256"];

export async function verifyWithRealmSecret<T>(token: string, realm: SigningRealm): Promise<T | null> {
  const realmSecret = await getRealmSecret(realm);
  try {
    const { payload } = await jwtVerify(token, realmSecret, { algorithms: ACCEPTED_ALGORITHMS });
    return payload as T;
  } catch (err) {
    try {
      const prevSecret = await getRealmSecret(realm, true);
      const { payload } = await jwtVerify(token, prevSecret, { algorithms: ACCEPTED_ALGORITHMS });
      return payload as T;
    } catch {
      throw err;
    }
  }
}

// Preserve existing export for things that haven't migrated yet
export function __clearJwtCache() {
  cache.clear();
}

export function getJwtSecret(context: string): Uint8Array {
  return getBaseSecret();
}
