import { NextRequest, NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";
import { isInternalCall } from "@/lib/internal-auth";

/**
 * The Postgres half of the rate limiter (Phase 24 Wave 5).
 *
 * Middleware owns the policy — which paths are limited, under which key, at
 * what ceiling — and this route owns only the durable counter, because the
 * Edge runtime middleware executes in cannot open a database connection. It
 * exists to survive the two things the old in-process `Map`s could not: a
 * restart, and a second replica.
 *
 * **It is not a public endpoint, and it authenticates as one that isn't.**
 * There is no session to require: the buckets that matter most cover login
 * attempts, which by definition arrive without one. So the caller proves it
 * is our own middleware with the `x-internal-auth` secret derived from
 * JWT_SECRET (see src/lib/internal-auth.ts). Without that check anyone able
 * to reach the app could write arbitrary keys and counts into `rate_limits`
 * — spending another IP's login bucket to lock them out, or resetting their
 * own to walk past the brute-force limiter that Phase 24 exists to add.
 *
 * The route also refuses to take the caller's word for the current time.
 * `now` used to come from the body, which let a caller rewind their own
 * window indefinitely; the window is anchored on the database clock instead,
 * and the request body now only names the bucket and its policy.
 */

/** Ceilings on what a caller may ask for, so a forged body cannot widen a bucket. */
const MAX_LIMIT = 10_000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LENGTH = 256;

export async function POST(request: NextRequest) {
  if (!(await isInternalCall(request.headers))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { key?: unknown; limit?: unknown; windowMs?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key : "";
  const limit = Number(body.limit);
  const windowMs = Number(body.windowMs);
  if (
    !key ||
    key.length > MAX_KEY_LENGTH ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT ||
    !Number.isInteger(windowMs) ||
    windowMs < 1 ||
    windowMs > MAX_WINDOW_MS
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  return withoutTenantScope("platform", async () => {
    // One statement, so the read-modify-write cannot interleave with another
    // replica's: the row is locked by the UPDATE half of the upsert, and both
    // the "has the window rolled over" test and the increment are evaluated
    // against `now()` on the server rather than a value from the request.
    const { rows } = await query<{ count: number; window_start_ms: string }>(
      `
      INSERT INTO rate_limits (key, count, window_start)
      VALUES ($1, 1, now())
      ON CONFLICT (key) DO UPDATE
      SET count = CASE
                    WHEN rate_limits.window_start <= now() - ($2::bigint * interval '1 millisecond')
                    THEN 1
                    ELSE rate_limits.count + 1
                  END,
          window_start = CASE
                           WHEN rate_limits.window_start <= now() - ($2::bigint * interval '1 millisecond')
                           THEN now()
                           ELSE rate_limits.window_start
                         END
      RETURNING count, EXTRACT(EPOCH FROM window_start) * 1000 AS window_start_ms
      `,
      [key, windowMs],
    );

    const count = Number(rows[0].count);
    const windowStartMs = Number(rows[0].window_start_ms);
    const allowed = count <= limit;
    const elapsed = Date.now() - windowStartMs;
    const retryAfterMs = allowed ? 0 : Math.max(0, windowMs - elapsed);

    return NextResponse.json({ allowed, retryAfterMs });
  });
}
