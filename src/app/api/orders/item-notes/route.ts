import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";

/**
 * Suggested line notes for one menu item — the distinct notes the business
 * has actually taken on that item, newest first, deduped and capped (eight).
 *
 * The till's «+ افزودن یادداشت» sheet offers these as one-tap chips so the
 * common requests («بدون شکر», «کم‌نمک») stop being typed from scratch. Reads
 * the same `order_items.note` the kitchen tickets print, so the suggestions
 * can only ever be phrases the kitchen has already seen.
 *
 * GET /api/orders/item-notes?itemId=<uuid>
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requireRole("owner", "manager", "cashier", "waiter");
  if (error) return error;

  const itemId = new URL(request.url).searchParams.get("itemId") ?? "";
  const trimmedId = itemId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(trimmedId)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { rows } = await query<{ note: string }>(
    `SELECT btrim(oi.note) AS note,
            max(oi.created_at) AS last_used
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
      WHERE o.business_id = $1
        AND oi.menu_item_id = $2::uuid
        AND oi.note IS NOT NULL
        AND btrim(oi.note) <> ''
      GROUP BY btrim(oi.note)
      ORDER BY last_used DESC
      LIMIT 8`,
    [session.businessId, trimmedId],
  );

  // Grouped notes already deduped by SQL (btrim + GROUP BY); cap again in
  // case future callers raise the limit, and keep them short enough to chip.
  const notes = rows.map((row) => row.note).filter((note) => note.length <= 80).slice(0, 8);
  return NextResponse.json({ notes });
});
