/**
 * Professional error handling (Section 12 of the desktop audit) — pure
 * helpers shared by every render-error boundary (`error.tsx`,
 * `global-error.tsx`) so each failure gets the same three things: a
 * friendly Persian message (already handled by those files' own copy), a
 * short **error ID** the user can quote to support, and a downloadable
 * **technical log** with the detail nobody should have to read on screen.
 *
 * Kept deliberately separate from the render-boundary components: this file
 * touches neither React nor the DOM, so it is unit-testable the same way
 * every other pure `lib` module is, and the boundaries stay thin wrappers
 * around it.
 */

/**
 * A short, support-friendly identifier — distinct from Next's own opaque
 * `error.digest` (a server-log correlation id that is not always present,
 * e.g. for an error thrown entirely client-side). Deterministic given the
 * same `(seed, now)` pair so a re-render of the same boundary before the
 * user reloads keeps showing the same code instead of minting a new one
 * every paint.
 *
 * Shape: `ERR-XXXX-XXXX` in Crockford's base32 alphabet (no 0/O/1/I/L
 * confusion when read aloud over the phone to support).
 */
const BASE32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function toBase32(value: number, length: number): string {
  let n = Math.abs(Math.trunc(value));
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out = BASE32_ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** FNV-1a — small, dependency-free, good enough to spread a seed string across the id's bits. */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function generateErrorId(seed: string, now: number = Date.now()): string {
  const h = hash32(`${seed}:${now}`);
  const first = h & 0xffff;
  const second = (h >>> 16) & 0xffff;
  return `ERR-${toBase32(first, 4)}-${toBase32(second, 4)}`;
}

export interface ErrorReportContext {
  errorId: string;
  message: string;
  stack?: string | null;
  /** Next's own server-log correlation id, when this boundary received one. */
  digest?: string | null;
  /** Where the user was when it happened — a URL, not a component name, so it means something to support. */
  url?: string;
  userAgent?: string;
  /** ISO timestamp; pass one explicitly from a test for a deterministic report. */
  occurredAt?: string;
  /** App/desktop release version, when known (APP_RELEASE_VERSION et al.). */
  appVersion?: string;
}

/**
 * Renders the same secret-redaction rule the desktop's own log writer uses
 * (electron/logger.js's `redact`), so a technical report exported from the
 * browser never leaks a connection string, bearer token, or password that
 * happened to be in an error message.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+/gi,
  /(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi,
  /((?:jwt|sync|pairing|api)[_-]?(?:secret|token|code)\s*[:=]\s*)[^\s,;]+/gi,
  /((?:password|passphrase)\s*[:=]\s*)[^\s,;]+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "$1[REDACTED]");
  return out;
}

/** Plain-text technical report — the content of the "Export Logs" download, never rendered on screen. */
export function buildTechnicalReport(context: ErrorReportContext): string {
  const lines = [
    `Error ID: ${context.errorId}`,
    `Occurred at: ${context.occurredAt ?? new Date().toISOString()}`,
    context.digest ? `Server digest: ${context.digest}` : null,
    context.appVersion ? `App version: ${context.appVersion}` : null,
    context.url ? `URL: ${context.url}` : null,
    context.userAgent ? `User agent: ${context.userAgent}` : null,
    "",
    `Message: ${redactSecrets(context.message)}`,
    context.stack ? "" : null,
    context.stack ? "Stack:" : null,
    context.stack ? redactSecrets(context.stack) : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

const CLIENT_ERROR_LOG_KEY = "pos:clientErrorLog";
/** Ring buffer cap — enough recent errors for a support session without growing localStorage unbounded. */
const MAX_LOGGED_ERRORS = 50;

export interface StoredErrorEntry {
  errorId: string;
  occurredAt: string;
  report: string;
}

function readStoredErrors(storage: Pick<Storage, "getItem">): StoredErrorEntry[] {
  try {
    const raw = storage.getItem(CLIENT_ERROR_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredErrorEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Appends one error's technical report to a capped local ring buffer, so
 * "Export Logs" can hand support more than just the one error currently on
 * screen — the sequence of failures leading up to it is often the useful
 * part. Silently a no-op if storage is unavailable (private browsing, quota
 * exceeded): the on-screen error ID/report still exists for this one error.
 */
export function recordClientError(
  entry: StoredErrorEntry,
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): void {
  if (!storage) return;
  try {
    const existing = readStoredErrors(storage);
    const next = [...existing, entry].slice(-MAX_LOGGED_ERRORS);
    storage.setItem(CLIENT_ERROR_LOG_KEY, JSON.stringify(next));
  } catch {
    // Best-effort only — never let logging itself throw inside an error boundary.
  }
}

/** The full exportable log — every stored report, newest last, for the download button. */
export function exportClientErrorLog(
  storage: Storage | undefined = typeof window !== "undefined" ? window.localStorage : undefined,
): string {
  if (!storage) return "";
  const entries = readStoredErrors(storage);
  if (entries.length === 0) return "";
  return entries.map((entry) => entry.report).join("\n\n" + "=".repeat(40) + "\n\n");
}
