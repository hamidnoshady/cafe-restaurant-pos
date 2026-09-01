/**
 * One-shot smoke test for the support ticketing services (migration 0130),
 * run against the local Postgres. Not part of the test suite — a manual
 * end-to-end check of the SQL paths. Run:
 *   DATABASE_URL=postgres://pos:pos@127.0.0.1:5433/pos npx tsx scripts/smoke-support-tickets.ts
 */
import { randomUUID } from "node:crypto";
import { query, withoutTenantScope } from "../src/lib/db";
import { businessScope, runInTenantScope } from "../src/lib/tenant-context";
import {
  createMemberTicket,
  listMemberTickets,
  getMemberTicket,
  addMemberMessage,
  setMemberTicketStatus,
} from "../src/lib/support-service";
import {
  listSupportTickets,
  getSupportTicket,
  addSupportMessage,
  updateSupportTicket,
  supportTicketStats,
} from "../src/lib/platform-service";

async function main() {
  const suffix = randomUUID().slice(0, 8);
  const [biz] = (
    await query<{ id: string }>(`INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`, [
      `Smoke Cafe ${suffix}`,
      `smoke-${suffix}`,
    ])
  ).rows;
  const [loc] = (
    await query<{ id: string }>(`INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id`, [biz.id])
  ).rows;
  const [owner] = (
    await query<{ id: string }>(
      `INSERT INTO users (business_id, location_id, role, full_name, pin_hash) VALUES ($1, $2, 'owner', 'Smoke Owner', 'x') RETURNING id`,
      [biz.id, loc.id],
    )
  ).rows;
  const [cashier] = (
    await query<{ id: string }>(
      `INSERT INTO users (business_id, location_id, role, full_name, pin_hash) VALUES ($1, $2, 'cashier', 'Smoke Cashier', 'x') RETURNING id`,
      [biz.id, loc.id],
    )
  ).rows;

  const run = <T>(fn: () => Promise<T>) => runInTenantScope(businessScope(biz.id, loc.id, owner.id), fn);

  // --- Member side ----------------------------------------------------------
  const created = await run(() =>
    createMemberTicket({
      businessId: biz.id,
      locationId: loc.id,
      userId: owner.id,
      subject: "چاپگر کار نمی‌کند",
      category: "technical",
      priority: "high",
      body: "چاپگر بعد از به‌روزرسانی قطع شده است.",
      attachment: null,
    }),
  );
  console.log("created ticket:", created.id, created.status, created.subject, "| messages:", created.messages.length);
  if (created.status !== "open" || created.messages.length !== 1) throw new Error("create failed");

  // Cashier must not see the owner's ticket…
  const cashierList = await run(() =>
    listMemberTickets({ businessId: biz.id, userId: cashier.id, role: "cashier" }),
  );
  if (cashierList.length !== 0) throw new Error("cashier leaked owner ticket");
  // …but the owner sees the whole queue.
  const ownerList = await run(() => listMemberTickets({ businessId: biz.id, userId: owner.id, role: "owner" }));
  if (ownerList.length !== 1) throw new Error("owner list wrong");
  console.log("visibility rules ok: cashier 0, owner", ownerList.length);

  // Cashier cannot open the owner's ticket detail.
  const cashierDetail = await run(() =>
    getMemberTicket({ businessId: biz.id, userId: cashier.id, role: "cashier", ticketId: created.id }),
  );
  if (cashierDetail !== null) throw new Error("cashier read owner ticket detail");

  // Member reply moves open -> in_progress.
  const msg = await run(() =>
    addMemberMessage({ businessId: biz.id, userId: owner.id, role: "owner", ticketId: created.id, body: "لطفاً بررسی کنید", attachment: null }),
  );
  if (msg.authorType !== "member") throw new Error("bad author");
  const afterReply = await run(() => getMemberTicket({ businessId: biz.id, userId: owner.id, role: "owner", ticketId: created.id }));
  if (afterReply!.status !== "in_progress") throw new Error(`expected in_progress, got ${afterReply!.status}`);
  console.log("member reply ok ->", afterReply!.status);

  // Close and reopen from the member side.
  await run(() => setMemberTicketStatus({ businessId: biz.id, userId: owner.id, role: "owner", ticketId: created.id, status: "closed" }));
  const closed = await run(() => getMemberTicket({ businessId: biz.id, userId: owner.id, role: "owner", ticketId: created.id }));
  if (closed!.status !== "closed" || !closed!.closedAt) throw new Error("close failed");
  await run(() => setMemberTicketStatus({ businessId: biz.id, userId: owner.id, role: "owner", ticketId: created.id, status: "open" }));
  const reopened = await run(() => getMemberTicket({ businessId: biz.id, userId: owner.id, role: "owner", ticketId: created.id }));
  if (reopened!.status !== "open" || reopened!.closedAt !== null) throw new Error("reopen failed");
  console.log("member close/reopen ok");

  // --- Platform side --------------------------------------------------------
  const [admin] = (
    await withoutTenantScope("platform", () =>
      query<{ id: string }>(`INSERT INTO platform_admins (email, password_hash, full_name) VALUES ($1, 'x', 'Smoke Admin') RETURNING id`, [
        `smoke-${suffix}@example.com`,
      ]),
    )
  ).rows;

  const list = await listSupportTickets({ search: "چاپگر" });
  const found = list.find((t) => t.id === created.id);
  if (!found) throw new Error("platform list missed ticket");
  console.log("platform list ok:", found.businessName, found.userName, "| count:", found.messageCount);

  const detail = await getSupportTicket(created.id);
  if (!detail || detail.messages.length !== 2) throw new Error("platform detail wrong");

  // Admin reply: waiting_customer, audited.
  const adminMsg = await addSupportMessage({ ticketId: created.id, adminId: admin.id, body: "فیکس شد؛ به‌روزرسانی بعدی را نصب کنید.", attachment: null });
  if (adminMsg.authorType !== "admin") throw new Error("bad admin author");
  const afterAdmin = await getSupportTicket(created.id);
  if (afterAdmin!.status !== "waiting_customer") throw new Error(`expected waiting_customer, got ${afterAdmin!.status}`);
  const audit = await withoutTenantScope("platform", () =>
    query<{ n: string }>(`SELECT count(*)::text AS n FROM platform_audit_log WHERE action = 'support.ticket.reply' AND entity_id = $1`, [created.id]),
  );
  if (Number(audit.rows[0].n) !== 1) throw new Error("reply not audited");
  console.log("platform reply ok ->", afterAdmin!.status, "| audited:", audit.rows[0].n);

  // Update: status + priority + assignment.
  const updated = await updateSupportTicket({ ticketId: created.id, adminId: admin.id, status: "resolved", priority: "urgent", assignedAdminId: admin.id });
  if (updated!.status !== "resolved" || updated!.priority !== "urgent" || updated!.assignedAdminId !== admin.id) {
    throw new Error("update failed");
  }
  console.log("platform update ok ->", updated!.status, updated!.priority, "assigned:", updated!.assignedAdminName);

  // Reopen + stats.
  await updateSupportTicket({ ticketId: created.id, adminId: admin.id, status: "open" });
  const stats = await supportTicketStats();
  if (stats.open < 1 || stats.urgentOpen < 1) throw new Error("stats wrong");
  console.log("stats ok:", JSON.stringify(stats));

  // Tenant RLS: a second business must see nothing.
  const [biz2] = (
    await query<{ id: string }>(`INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id`, [`Smoke2 ${suffix}`, `smoke2-${suffix}`])
  ).rows;
  const [cashier2] = (
    await query<{ id: string }>(
      `INSERT INTO users (business_id, location_id, role, full_name, pin_hash) VALUES ($1, NULL, 'cashier', 'Smoke2 C', 'x') RETURNING id`,
      [biz2.id],
    )
  ).rows;
  const otherList = await runInTenantScope(businessScope(biz2.id, null, cashier2.id), () =>
    listMemberTickets({ businessId: biz2.id, userId: cashier2.id, role: "cashier" }),
  );
  if (otherList.length !== 0) throw new Error("cross-tenant leak");
  console.log("cross-tenant isolation ok");

  // Cleanup.
  await query(`DELETE FROM businesses WHERE id = $1`, [biz.id]);
  await query(`DELETE FROM businesses WHERE id = $1`, [biz2.id]);
  await withoutTenantScope("platform", () => query(`DELETE FROM platform_admins WHERE id = $1`, [admin.id]));
  console.log("smoke test PASSED");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
