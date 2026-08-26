import { NextRequest, NextResponse } from "next/server";
import { query, withoutTenantScope } from "@/lib/db";

// Internal API route for rate-limiting check
// POST /api/internal/rate-limit
export async function POST(request: NextRequest) {
  const { key, limit, windowMs, now } = await request.json();

  return withoutTenantScope("platform", async () => {
    // Upsert the count if window is valid, or reset it
    const { rows } = await query(
      `
      INSERT INTO rate_limits (key, count, window_start)
      VALUES ($1, 1, to_timestamp($4 / 1000.0))
      ON CONFLICT (key) DO UPDATE
      SET 
        count = CASE 
                  WHEN EXTRACT(EPOCH FROM now()) * 1000 - EXTRACT(EPOCH FROM rate_limits.window_start) * 1000 >= $3
                  THEN 1 
                  ELSE rate_limits.count + 1 
                END,
        window_start = CASE 
                         WHEN EXTRACT(EPOCH FROM now()) * 1000 - EXTRACT(EPOCH FROM rate_limits.window_start) * 1000 >= $3
                         THEN to_timestamp($4 / 1000.0)
                         ELSE rate_limits.window_start
                       END
      RETURNING count, EXTRACT(EPOCH FROM window_start) * 1000 as window_start_ms;
      `,
      [key, limit, windowMs, now]
    );

    const count = Number(rows[0].count);
    const windowStartMs = Number(rows[0].window_start_ms);
    const allowed = count <= limit;
    const retryAfterMs = allowed ? 0 : Math.max(0, windowMs - (now - windowStartMs));

    return NextResponse.json({ allowed, retryAfterMs });
  });
}
