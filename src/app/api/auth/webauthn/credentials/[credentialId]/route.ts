import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { EmployeeError, revokeCredential } from "@/lib/employee-service";

/** Revokes one of the caller's own registered authenticators — never another employee's, see revokeCredential's ownerEmployeeId. */
export const DELETE = withTenantScope(
  async (_request, context: { params: Promise<{ credentialId: string }> }) => {
    const { session, error } = await requireRole("cashier", "waiter", "kitchen");
    if (error) return error;
    const { credentialId } = await context.params;

    try {
      await revokeCredential(credentialId, session.businessId, session.sub, session.sub);
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (err instanceof EmployeeError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  },
);
