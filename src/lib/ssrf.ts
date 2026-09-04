/**
 * Is this URL safe for the *server* to fetch on a caller's say-so?
 *
 * Anywhere the app takes a URL from a request and then requests it itself, the
 * app becomes an HTTP client sitting inside the private network — which is the
 * one place an outside caller cannot reach. On this deployment that network
 * holds Postgres, LiteLLM, OpenObserve and Komodo's core and periphery, none of
 * which expect a request from the app to be hostile, plus whatever the cloud
 * provider serves on 169.254.169.254.
 *
 * Two rules, because either alone is bypassable:
 *
 *   1. **The literal.** `https://127.0.0.1/`, `https://[::1]/`,
 *      `https://169.254.169.254/` — rejected on the address in the URL.
 *   2. **The name.** `https://internal.attacker.example/` is a public-looking
 *      hostname whose A record is `10.0.0.5`. Only resolving it catches that,
 *      so the host is looked up and *every* address it returns must be
 *      publicly routable — one private answer among several is still a hit.
 *
 * A name that does **not** resolve is allowed through, which is deliberate and
 * worth stating: it cannot be connected to at all, so `fetch` fails on its own
 * and refusing it buys no safety — while refusing it *would* mean a resolver
 * blip rejects a legitimate push endpoint, and that a test or an air-gapped
 * install could never register one. The property this guard actually owes is
 * "nothing leaves to a private address", and an unreachable name is not one.
 *
 * What this deliberately does not solve is DNS rebinding: a name that answers
 * public here and private microseconds later, when `fetch` resolves it a second
 * time. Closing that needs the connection pinned to the address that was
 * checked (a custom agent with a `lookup`), which is a larger change than the
 * call sites here justify. Checking immediately before each fetch — rather than
 * once when a URL is stored — is what keeps the window to that race instead of
 * to "whenever the attacker updates their zone".
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Hostnames that name this machine or a private namespace however they resolve. */
const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

function ipv4IsPrivate(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;

  return (
    a === 0 || // "this network"
    a === 10 || // RFC 1918
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // RFC 6598 carrier-grade NAT
    (a === 169 && b === 254) || // link-local — cloud instance metadata
    (a === 172 && b >= 16 && b <= 31) || // RFC 1918
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 192 && b === 168) || // RFC 1918
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

function ipv6IsPrivate(ip: string): boolean {
  const address = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];

  // An IPv4-mapped address (::ffff:10.0.0.5) is an IPv4 destination wearing a
  // different notation, and reaches exactly the same host.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return ipv4IsPrivate(mapped[1]);

  return (
    address === "::" ||
    address === "::1" || // loopback
    address.startsWith("fc") || // unique local
    address.startsWith("fd") ||
    address.startsWith("fe8") || // link-local
    address.startsWith("fe9") ||
    address.startsWith("fea") ||
    address.startsWith("feb") ||
    address.startsWith("ff") // multicast
  );
}

/** Whether a bare IP address — v4 or v6 — is one the app must not be pointed at. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip.replace(/^\[|\]$/g, ""));
  if (version === 4) return ipv4IsPrivate(ip);
  if (version === 6) return ipv6IsPrivate(ip);
  return true; // not an address at all — the caller should not be guessing
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * `https` only, and pointed somewhere on the public internet.
 *
 * Returns a reason rather than throwing: every caller is deciding whether to
 * store or send something, and wants to say why it refused.
 */
export async function assertPublicHttpsUrl(raw: string): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not_a_url" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) return { ok: false, reason: "no_host" };

  if (hostname === "localhost" || PRIVATE_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return { ok: false, reason: "private_host" };
  }

  if (isIP(hostname.replace(/^\[|\]$/g, ""))) {
    return isPrivateAddress(hostname) ? { ok: false, reason: "private_host" } : { ok: true, url };
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    // Does not resolve, so it reaches nothing — see the note above on why that
    // is allowed rather than refused.
    return { ok: true, url };
  }

  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    return { ok: false, reason: "private_host" };
  }

  return { ok: true, url };
}
