/**
 * Phase 20 Wave 3 — WebAuthn/biometric authentication: the @simplewebauthn
 * wrapper plus the short-lived ceremony-challenge token. This module wraps a
 * library (the same way team.ts wraps bcrypt) rather than being fully
 * framework-free, but it has no database access of its own —
 * employee-service.ts calls into it exactly the way it calls into team.ts's
 * isValidPin, and owns everything that touches employee_credentials.
 *
 * A WebAuthn ceremony (register or authenticate) is two calls: "begin" hands
 * the browser a challenge to sign, "complete" verifies what came back
 * against that same challenge. Every other credential/session in this phase
 * gets a server-side row (employee_sessions, employee_credentials) because
 * it needs to be listable and revocable — a ceremony challenge needs neither;
 * it exists for under two minutes and is worthless the moment it's used or
 * expires. So instead of a table, the challenge travels as a short-lived,
 * signed JWT (`signChallenge`/`verifyChallenge`, same JWT_SECRET and `jose`
 * signing helper as auth-edge.ts's session token) handed to the caller
 * alongside the WebAuthn options and echoed back unmodified on the follow-up
 * call — the caller/browser never reads it, just relays it.
 */
import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getJwtSecret } from "./jwt-secret";

/** Long enough for a fingerprint/face prompt; short enough that a stale token is useless. */
const CHALLENGE_TTL_SECONDS = 120;

export const CHALLENGE_PURPOSES = ["webauthn-register", "webauthn-authenticate"] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/** One deployment == one domain (see auth-edge.ts's REALM comment on the shared JWT_SECRET) — a single RP ID/origin pair covers every business. */
export function rpId(): string {
  return process.env.WEBAUTHN_RP_ID || "localhost";
}

export function rpName(): string {
  return process.env.WEBAUTHN_RP_NAME || "سیستم فروش کافه و رستوران";
}

export function expectedOrigin(): string | string[] {
  const raw = process.env.WEBAUTHN_ORIGIN;
  if (!raw) return "http://localhost:3000";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ChallengeClaims {
  purpose: ChallengePurpose;
  employeeId: string;
  businessId: string;
  challenge: string;
}

/** Exported (rather than kept module-private) so webauthn.test.ts can cover the sign/verify round trip without a real authenticator — the same reasoning employee.ts's generateSessionToken/hashSessionToken are exported for. */
export async function signChallenge(claims: ChallengeClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${CHALLENGE_TTL_SECONDS}s`)
    .sign(getJwtSecret("webauthn ceremony challenges"));
}

/** Returns the original challenge string if `token` is a live, matching challenge — null otherwise (expired, tampered, or for a different employee/business/purpose). */
export async function verifyChallenge(
  token: string,
  purpose: ChallengePurpose,
  employeeId: string,
  businessId: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret("webauthn ceremony challenges"), {
      algorithms: ["HS256"],
    });
    const claims = payload as unknown as ChallengeClaims;
    if (claims.purpose !== purpose || claims.employeeId !== employeeId || claims.businessId !== businessId) {
      return null;
    }
    return claims.challenge;
  } catch {
    return null;
  }
}

export interface CredentialDescriptor {
  id: string;
  transports?: AuthenticatorTransportFuture[] | null;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export async function buildRegistrationOptions(
  employeeId: string,
  businessId: string,
  displayName: string,
  excludeCredentials: CredentialDescriptor[],
): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; challengeToken: string }> {
  const options = await generateRegistrationOptions({
    rpName: rpName(),
    rpID: rpId(),
    // Not employees.id itself — WebAuthn user handles are visible to the
    // authenticator/OS credential manager, and randomUUID() keeps that
    // opaque the same way employee_sessions' token does, rather than
    // exposing our own primary key to the device.
    userID: new TextEncoder().encode(randomUUID()),
    userName: displayName,
    userDisplayName: displayName,
    attestationType: "none",
    excludeCredentials: excludeCredentials.map((c) => ({
      id: c.id,
      transports: c.transports ?? undefined,
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challengeToken = await signChallenge({
    purpose: "webauthn-register",
    employeeId,
    businessId,
    challenge: options.challenge,
  });
  return { options, challengeToken };
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: AuthenticatorTransportFuture[] | null;
}

/** Verifies a completed registration ceremony against the challenge it was issued for. Null on any failure — caller doesn't need to distinguish why. */
export async function verifyRegistration(
  employeeId: string,
  businessId: string,
  response: RegistrationResponseJSON,
  challengeToken: string,
): Promise<VerifiedRegistration | null> {
  const challenge = await verifyChallenge(challengeToken, "webauthn-register", employeeId, businessId);
  if (!challenge) return null;

  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigin(),
      expectedRPID: rpId(),
    });
    if (!result.verified || !result.registrationInfo) return null;
    const { credential } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString("base64"),
      signCount: credential.counter,
      transports: credential.transports ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function buildAuthenticationOptions(
  employeeId: string,
  businessId: string,
  allowCredentials: CredentialDescriptor[],
): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; challengeToken: string }> {
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    allowCredentials: allowCredentials.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
    userVerification: "preferred",
  });
  const challengeToken = await signChallenge({
    purpose: "webauthn-authenticate",
    employeeId,
    businessId,
    challenge: options.challenge,
  });
  return { options, challengeToken };
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: AuthenticatorTransportFuture[] | null;
}

/** Verifies a completed authentication ceremony against `stored` (the row matching response.id). Returns the authenticator's new signature counter on success, null on any failure. */
export async function verifyAuthentication(
  employeeId: string,
  businessId: string,
  response: AuthenticationResponseJSON,
  challengeToken: string,
  stored: StoredCredential,
): Promise<{ newSignCount: number } | null> {
  const challenge = await verifyChallenge(challengeToken, "webauthn-authenticate", employeeId, businessId);
  if (!challenge) return null;

  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: expectedOrigin(),
      expectedRPID: rpId(),
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64")),
        counter: stored.signCount,
        transports: stored.transports ?? undefined,
      },
    });
    if (!result.verified) return null;
    return { newSignCount: result.authenticationInfo.newCounter };
  } catch {
    return null;
  }
}
