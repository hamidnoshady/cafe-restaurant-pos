import { NextResponse } from "next/server";
import { requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { query } from "@/lib/db";

/**
 * Per-business commercial overrides (§25, migration 0176): a super-admin
 * exception that never mutates the global plan — a custom limit or a
 * temporary capability. Every override carries a reason, its author, an
 * optional expiry and a full audit entry with before/after values.
 */
const LIMIT_TARGETS = new Set(["branch_limit", "member_limit", "monthly_order_limit"]);

export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("adjustments.manage");
    if (guard.error) return guard.error;
    const { id: businessId } = await ctx.params;

    let body: {
      action?: string;
      kind?: string;
      target?: string;
      unlimited?: boolean;
      value?: number;
      enabled?: boolean;
      reason?: string;
      expiresAt?: string | null;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const action = body.action ?? "set";

    if (action === "remove") {
      const target = String(body.target ?? "");
      if (!target) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
      const { rows } = await query<{ id: string; kind: string; value_int: number | null; value_bool: boolean | null }>(
        `DELETE FROM business_billing_overrides
          WHERE business_id = $1 AND target = $2
          RETURNING id, kind, value_int, value_bool`,
        [businessId, target],
      );
      if (rows[0]) {
        await platformAudit({
          adminId: guard.session.padmin,
          businessId,
          action: "business.override.removed",
          entity: "business_billing_overrides",
          entityId: rows[0].id,
          payload: { target, kind: rows[0].kind, valueInt: rows[0].value_int, valueBool: rows[0].value_bool },
        });
      }
      return NextResponse.json({ ok: true });
    }

    const kind = body.kind === "capability" ? "capability" : "limit";
    const target = String(body.target ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    if (!target || reason.length < 4) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }

    let valueInt: number | null = null;
    let valueBool: boolean | null = null;
    if (kind === "limit") {
      if (!LIMIT_TARGETS.has(target)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      if (body.unlimited === true) {
        valueInt = null;
      } else {
        const value = Math.floor(Number(body.value ?? NaN));
        if (!Number.isSafeInteger(value) || value < 0) {
          return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
        }
        valueInt = value;
      }
    } else {
      valueBool = body.enabled === true;
    }

    const expiresAt =
      typeof body.expiresAt === "string" && body.expiresAt
        ? new Date(body.expiresAt).toISOString()
        : null;
    if (body.expiresAt && Number.isNaN(new Date(body.expiresAt).getTime())) {
      return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    }

    const { rows: before } = await query<{ id: string; value_int: number | null; value_bool: boolean | null }>(
      `SELECT id, value_int, value_bool FROM business_billing_overrides
        WHERE business_id = $1 AND kind = $2 AND target = $3`,
      [businessId, kind, target],
    );

    const { rows } = await query<{ id: string }>(
      `INSERT INTO business_billing_overrides
         (business_id, kind, target, value_int, value_bool, reason, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (business_id, kind, target) DO UPDATE SET
         value_int = EXCLUDED.value_int,
         value_bool = EXCLUDED.value_bool,
         reason = EXCLUDED.reason,
         created_by = EXCLUDED.created_by,
         created_at = now(),
         expires_at = EXCLUDED.expires_at,
         active = true
       RETURNING id`,
      [businessId, kind, target, valueInt, valueBool, reason, guard.session.padmin, expiresAt],
    );

    await platformAudit({
      adminId: guard.session.padmin,
      businessId,
      action: "business.override.created",
      entity: "business_billing_overrides",
      entityId: rows[0].id,
      payload: {
        kind,
        target,
        before: before[0] ? { valueInt: before[0].value_int, valueBool: before[0].value_bool } : null,
        after: { valueInt, valueBool },
        reason,
        expiresAt,
      },
    });
    return NextResponse.json({ ok: true, id: rows[0].id });
  },
);
