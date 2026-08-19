/**
 * Phase 17 performance review — the pg Pool's `max` was a hardcoded 20 with
 * no stated basis (see src/lib/db.ts). A transaction (order creation,
 * payment/inventory consumption) pins one connection for its full
 * `BEGIN…COMMIT`, so the right ceiling scales with how many businesses'
 * concurrent write transactions one deployment expects to serve at once —
 * that number varies by deployment (one café vs. several sharing a host),
 * so it's now an env var instead of a constant, with the old value kept as
 * the default so nothing changes for anyone who doesn't set it.
 */
export function poolMax(): number {
  const raw = Number(process.env.DB_POOL_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

/**
 * How long a checkout may wait before pg gives up on it (`connectionTimeoutMillis`).
 *
 * Zero — pg's default — means "wait forever", which is the wrong answer when
 * the wait is a DNS lookup the container runtime's resolver has silently
 * dropped: the request hangs for the OS resolver's full budget with nothing to
 * show for it (see db-retry.ts). The ceiling is deliberately far above any
 * realistic pool queue wait, so it bounds a hung *connection* without failing a
 * request that is merely queued behind busy transactions.
 */
export function connectTimeoutMs(): number {
  const raw = Number(process.env.DB_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30_000;
}
