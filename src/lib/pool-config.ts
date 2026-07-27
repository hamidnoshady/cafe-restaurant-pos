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
