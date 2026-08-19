/**
 * Riding out a database blip instead of turning it into a 500.
 *
 * Every shipped deployment reaches Postgres by *name* over a container network
 * — `db` in the compose files here, or whatever name the host's orchestrator
 * gave the database service — so every new pool connection begins with a DNS
 * lookup against the container runtime's embedded resolver. That resolver is
 * not always there: it drops queries under load, and it is briefly unreachable
 * while the network is reconfigured or the database container is replaced.
 * Node reports that as `EAI_AGAIN` — "try again", transient by definition — and
 * node-postgres has no retry of its own, so one dropped lookup became an
 * unhandled error on whichever page or background tick happened to ask for a
 * connection at that moment.
 *
 * The load-bearing half of this is *where* the retry sits: only around checking
 * a connection **out of the pool**, never around a statement already in flight.
 * A checkout that failed to connect provably never reached the server, so
 * retrying it cannot repeat a write — which is why this must not be widened
 * into a general "retry failed queries" helper.
 */

/**
 * Socket-level failures that say "the database wasn't reachable just now",
 * as opposed to "the database answered and rejected this".
 *
 * `EAI_AGAIN` and `ENOTFOUND` are the resolver ones (the second shows up as
 * NXDOMAIN in the window where a replaced container has deregistered its name
 * but not yet re-registered it); the rest are the connection itself being
 * refused, reset, or timing out against a database that is still booting.
 */
const RETRYABLE_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "EAGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  // Postgres itself, before it can serve: "the database system is starting up".
  "57P03",
]);

/** Messages pg reports without a `code`, all of them a failed checkout. */
const RETRYABLE_MESSAGES =
  /(connection terminated (unexpectedly|due to connection timeout))|(timeout exceeded when trying to connect)|(the database system is (starting up|shutting down))|(connection refused)/i;

function errorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : "";
}

/**
 * Whether this failure is worth another checkout attempt.
 *
 * Deliberately narrow: an authentication failure, a missing database, or any
 * SQL error is permanent, and retrying it only delays the real report.
 */
export function isRetryableConnectError(err: unknown): boolean {
  const code = errorCode(err);
  if (code) return RETRYABLE_CODES.has(code);
  return RETRYABLE_MESSAGES.test(errorMessage(err));
}

/** How many checkout attempts one call gets, including the first. */
export function connectAttempts(): number {
  const raw = Number(process.env.DB_CONNECT_ATTEMPTS);
  if (!Number.isFinite(raw) || raw < 1) return 4;
  return Math.min(Math.floor(raw), 10);
}

/**
 * Backoff before attempt N+1: 100ms, 300ms, 900ms, then capped at 2s.
 *
 * A DNS blip clears in tens of milliseconds, so the first retry is quick on
 * purpose — the whole point is that the request survives it rather than that it
 * waits patiently. Four attempts spend at most ~1.3s before giving up, which is
 * still inside any sane request budget.
 */
export function connectRetryDelayMs(attempt: number): number {
  const step = Math.max(1, Math.floor(attempt));
  return Math.min(100 * 3 ** (step - 1), 2_000);
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `connect`, retrying only the transient failures above.
 *
 * `sleep` is injectable so this can be tested without real timers; everything
 * else defaults from the environment.
 */
export async function withConnectRetry<T>(
  connect: () => Promise<T>,
  options: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? connectAttempts();
  const delayMs = options.delayMs ?? connectRetryDelayMs;
  const sleep = options.sleep ?? sleepFor;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await connect();
    } catch (err) {
      if (attempt >= attempts || !isRetryableConnectError(err)) throw err;
      const delay = delayMs(attempt);
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}

/**
 * The host a connection string points at — and nothing else from it.
 *
 * Only ever the hostname: a connection string carries the password, so this is
 * the one field that may be repeated into a log line.
 */
export function connectionHost(connectionString: string | undefined | null): string | null {
  if (!connectionString) return null;
  try {
    const host = new URL(connectionString).hostname;
    if (host) return host.startsWith("[") ? host.slice(1, -1) : host;
  } catch {
    // Not a URL — fall through to libpq's key=value form.
  }
  const keyed = /(?:^|\s)host=([^\s]+)/.exec(connectionString);
  return keyed ? keyed[1] : null;
}

/**
 * An operator-readable line for a checkout that ran out of attempts.
 *
 * The raw `getaddrinfo EAI_AGAIN <name>` stack says nothing about what to do,
 * and it is the failure an on-site deployment is most likely to hit: the app
 * container and the database container have to share a network, and the host in
 * `DATABASE_URL` has to be the database service's actual name on it.
 */
export function describeConnectFailure(err: unknown, connectionString?: string | null): string {
  const host = connectionHost(connectionString);
  const named = host ? ` "${host}"` : "";
  const where = host ? ` at "${host}"` : "";
  const code = errorCode(err);

  if (code === "EAI_AGAIN" || code === "ENOTFOUND") {
    return (
      `Could not resolve the database host${named} (${code}). The app container has to be on the ` +
      `same network as the Postgres container, and the host in DATABASE_URL has to be that ` +
      `service's name on it — check that the database service is running and that the two names match.`
    );
  }
  if (code === "ECONNREFUSED") {
    return (
      `The database${where} refused the connection (ECONNREFUSED). It resolves, so the container ` +
      `is reachable — check that Postgres is up on the port in DATABASE_URL.`
    );
  }
  return `Could not reach the database${where}: ${errorMessage(err) || String(err)}`;
}
