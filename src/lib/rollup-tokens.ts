/**
 * Phase 9 — multi-location rollup: the token pair, on its own.
 *
 * `rollup.ts` is deliberately framework-free *and client-safe*: it is the
 * shared vocabulary of the push exchange, and client bundles reach it
 * transitively (`reports.ts` borrows its `addDays`, dashboard report
 * sections bundle `reports.ts`). The moment it imported `node:crypto` the
 * production build broke — webpack cannot resolve the `node:` scheme in a
 * client graph. The two functions that need it therefore live here, and
 * only server code (rollup-service.ts) imports them.
 */
import { createHash, randomBytes } from "node:crypto";

/** New per-location bearer token. Shown once at registration; only its hash is stored. */
export function generateRollupToken(): string {
  return `rlk_${randomBytes(24).toString("hex")}`;
}

export function hashRollupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
