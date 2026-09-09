/**
 * What did the owner actually paste into the desktop app's «کد اتصال» box, and
 * what did they type into its address box?
 *
 * This file exists because of a real, reproducible failure. The desktop
 * first-run screen asks for a *pairing code* — twelve characters,
 * `XXXX-XXXX-XXXX`, issued for one business and redeemable once. The only
 * place that issued one used to be the super-admin console, so an owner
 * looking around their own cloud dashboard found instead the one button that
 * says «ساخت توکن» — «اتصال‌های فنی» → «سرور راه دور» (formerly a settings
 * tab) — which mints a
 * `POS1-…` *sync token*: a different credential, for the already-paired
 * server-to-server channel. Pasting it into the desktop produced
 * `code_not_found`, rendered as «کد اتصال معتبر نیست» — "the token is wrong".
 *
 * The credential is now issuable from the owner's own dashboard (see
 * /api/connections/desktop), which removes the trap. `classifyConnectionCode`
 * closes it: a `POS1-…` in the pairing box is recognised for what it is and
 * said out loud, instead of being sent to the server to come back as a generic
 * "not valid".
 *
 * `normalizeServerAddress` is the other half of the same complaint — the
 * address is the one the owner is *logged in at*, so the natural gesture is to
 * copy it out of the browser's address bar. That yields `biz1.example.com`,
 * `https://biz1.example.com/dashboard`, or a value with Persian digits from a
 * Persian keyboard. All three name the same server, so all three are accepted.
 *
 * Framework-free and isomorphic: the desktop pair form is a client component
 * and checks a pasted value before the round trip, so nothing here may import
 * `node:crypto`.
 */
import { foldDigits, PAIRING_CODE_ALPHABET } from "./code-alphabet";
import { API_KEY_PREFIX } from "./api-key-format";
import { SYNC_TOKEN_PREFIX } from "./sync-token";

/** Twelve alphabet characters, however they were grouped when typed. */
const PAIRING_CODE_LENGTH = 12;

export type ConnectionCodeKind =
  /** Nothing typed yet. */
  | "empty"
  /** A `XXXX-XXXX-XXXX` pairing code — what this box wants. */
  | "pairing_code"
  /** A `POS1-…` server-sync token — the mix-up this file is named for. */
  | "sync_token"
  /** A `posk_live_…` public API key — the third credential, also not this one. */
  | "api_key"
  /** Right length, but contains a character the alphabet never issues (`0`, `1`, `O`, `I`, …). */
  | "bad_charset"
  /** Recognisably a code, but not twelve characters long. */
  | "bad_length";

/**
 * Which of this product's three credentials — if any — was pasted.
 *
 * Deliberately checks the two *other* credentials by prefix before it judges
 * length or charset: "this is a sync token, not a connection code" is a far
 * more useful thing to tell someone than "wrong length", and it is the exact
 * mistake the flow invites.
 */
export function classifyConnectionCode(raw: string): ConnectionCodeKind {
  const trimmed = raw.trim();
  if (!trimmed) return "empty";

  const upper = foldDigits(trimmed).toUpperCase();
  if (upper.replace(/[^A-Z0-9]/g, "").startsWith(SYNC_TOKEN_PREFIX)) return "sync_token";
  // The API key prefix is lowercase and contains an underscore, so it is
  // compared against the raw value rather than the folded/uppercased one.
  if (trimmed.toLowerCase().startsWith(API_KEY_PREFIX)) return "api_key";

  // Note what is deliberately *not* done here: `normalizePairingCode` folds
  // 0→O and 1→I before hashing, and this does not follow it. The alphabet
  // excludes all four characters, so that fold maps one never-issued character
  // onto another never-issued one — a code containing any of them is a typo
  // either way, and it can only ever hash to something no row holds. Saying
  // «نویسه‌های نامعتبر» is the honest answer; letting it through to come back
  // as "code not found" is not. sync-token.ts made the same call for the same
  // reason.
  const body = upper.replace(/[^A-Z0-9]/g, "");
  if (body.length !== PAIRING_CODE_LENGTH) return "bad_length";
  if ([...body].some((ch) => !PAIRING_CODE_ALPHABET.includes(ch))) return "bad_charset";
  return "pairing_code";
}

export type ServerAddressResult =
  | { ok: true; url: string }
  | { ok: false; error: "missing_address" | "invalid_url" };

/**
 * Anything that names the cloud server -> the origin to call it on.
 *
 * A bare hostname gets `https://`, never `http://`: the pairing response
 * carries credential hashes for a whole business, and silently downgrading the
 * transport because someone omitted a scheme would be the wrong default. An
 * explicit `http://` is kept, because a laptop pairing against a server on the
 * same LAN is a real case and the owner has said so out loud.
 *
 * Any path, query or fragment is dropped — copying the address bar of a
 * logged-in dashboard yields `/dashboard`, and the pairing endpoint hangs off
 * the origin, not off wherever the owner happened to be standing.
 */
export function normalizeServerAddress(raw: string): ServerAddressResult {
  const trimmed = foldDigits(raw ?? "").trim();
  if (!trimmed) return { ok: false, error: "missing_address" };

  // A scheme that is present but not http(s) is rejected outright rather than
  // having `https://` prepended to it. Prepending would parse
  // `ftp://example.com` as the host `ftp` with a path — a silently wrong
  // address that then fails as "unreachable", which is the least useful thing
  // this could say.
  const declaredScheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (declaredScheme && declaredScheme !== "http" && declaredScheme !== "https") {
    return { ok: false, error: "invalid_url" };
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, error: "invalid_url" };
  // `new URL("https://")` throws, but `new URL("https://?x")` does not — it
  // parses to an empty hostname. A host with no dot and no port is accepted
  // (`localhost`), anything with a space or a userinfo section is not.
  if (!parsed.hostname || parsed.username || parsed.password) return { ok: false, error: "invalid_url" };

  return { ok: true, url: `${parsed.protocol}//${parsed.host}`.toLowerCase() };
}
