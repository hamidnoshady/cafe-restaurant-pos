/**
 * Phase G — «میز کار من», against a real database.
 *
 * `tenant-isolation.integration.test.ts` already proves every new table carries
 * RLS. This file proves the behaviour the module exists for, and above all the
 * promise the brief opens with: **existing project data survives**. So it
 * starts by creating a project through the OLD `ai-projects` service — the
 * pre-Phase-G write path, still live — and then reads it back through the new
 * workspace service, which is the exact journey an existing tenant's rows take.
 *
 * The rest covers the joins a unit test cannot: the two permission layers, the
 * approval gate propagating to its subject, document version chains, the
 * calendar's five sources unioned over one date range, the dependency guard,
 * and the report's spend figure coming from the ledger rather than from a
 * workspace counter.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let workspace: typeof import("../src/lib/workspace");
let legacyProjects: typeof import("../src/lib/ai-projects");

const alpha = { businessId: "", ownerId: "", memberId: "", outsiderId: "", partyId: "" };
const beta = { businessId: "", ownerId: "" };

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

beforeAll(async () => {
  databaseName = `pos_workspace_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  workspace = await import("../src/lib/workspace");
  legacyProjects = await import("../src/lib/ai-projects");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 180_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.getPool().end().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

async function seedBusiness(name: string, slug: string) {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = biz.rows[0].id;
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'owner', 'Owner', $2, 'x') RETURNING id`,
    [businessId, `owner-${slug}@example.test`],
  );
  return { businessId, ownerId: user.rows[0].id };
}

async function seedUser(businessId: string, name: string, slug: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, email, password_hash)
     VALUES ($1, 'manager', $2, $3, 'x') RETURNING id`,
    [businessId, name, `${slug}-${randomUUID().slice(0, 8)}@example.test`],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await db.query("DELETE FROM businesses");

  const a = await seedBusiness("Alpha", `alpha-${randomUUID().slice(0, 8)}`);
  alpha.businessId = a.businessId;
  alpha.ownerId = a.ownerId;
  alpha.memberId = await seedUser(a.businessId, "عضو تیم", "member");
  alpha.outsiderId = await seedUser(a.businessId, "همکار بیرون پروژه", "outsider");

  const party = await db.query<{ id: string }>(
    `INSERT INTO parties (business_id, name, role) VALUES ($1, 'کارفرمای الف', 'customer') RETURNING id`,
    [a.businessId],
  );
  alpha.partyId = party.rows[0].id;

  const b = await seedBusiness("Beta", `beta-${randomUUID().slice(0, 8)}`);
  beta.businessId = b.businessId;
  beta.ownerId = b.ownerId;
});

function owner(userId = alpha.ownerId) {
  return { businessId: alpha.businessId, actorUserId: userId, actorName: "Owner" };
}

/** Run inside Alpha's tenant scope — everything the service does needs one. */
function inAlpha<T>(fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(alpha.businessId, fn);
}

async function makeProject(overrides: Record<string, unknown> = {}) {
  return inAlpha(() =>
    workspace.createWorkspaceProject(owner(), {
      name: "برج شمال",
      description: "اجرای اسکلت و نما",
      status: "active",
      priority: "high",
      startDate: "2026-01-05",
      endDate: "2026-09-30",
      partyId: alpha.partyId,
      budgetRial: 5_000_000_000,
      tags: ["ساختمانی", "تهران"],
      ...overrides,
    }),
  );
}

/* ===========================================================================
 * The migration promise: old data, new module
 * ======================================================================== */

describe("existing project data", () => {
  it("is readable through the workspace service after the migration", async () => {
    // Written the pre-Phase-G way, through the service that has always owned
    // `ai_projects`. This is the shape every existing tenant's rows are in.
    const legacy = await inAlpha(() =>
      legacyProjects.createProject(
        { businessId: alpha.businessId, actorUserId: alpha.ownerId },
        { name: "کمپین بهار", instructions: "لحن دوستانه داشته باش" },
      ),
    );

    const seen = await inAlpha(() => workspace.getWorkspaceProject(alpha.businessId, legacy.id));
    expect(seen).not.toBeNull();
    expect(seen!.name).toBe("کمپین بهار");
    // 0167's defaults, applied to a row the old code wrote without them.
    expect(seen!.status).toBe("active");
    expect(seen!.priority).toBe("normal");
    expect(seen!.tags).toEqual([]);

    const list = await inAlpha(() =>
      workspace.listWorkspaceProjects(alpha.businessId, { status: "all" }),
    );
    expect(list.map((p) => p.id)).toContain(legacy.id);
  });

  it("keeps the old service working on a project the workspace created", async () => {
    const project = await makeProject();

    // The old note/memory/task paths must still write against a new project —
    // this is the "both APIs live at once" guarantee, not a one-way door.
    const note = await inAlpha(() =>
      legacyProjects.addNote(
        { businessId: alpha.businessId, actorUserId: alpha.ownerId, projectId: project.id },
        { title: "صورت‌جلسهٔ کارگاه", content: "بتن‌ریزی طبقهٔ سوم" },
      ),
    );
    expect(note.title).toBe("صورت‌جلسهٔ کارگاه");

    const notes = await inAlpha(() =>
      legacyProjects.listNotes({
        businessId: alpha.businessId,
        actorUserId: alpha.ownerId,
        projectId: project.id,
      }),
    );
    expect(notes).toHaveLength(1);
  });

  it("gives every existing project an owner member row", async () => {
    const legacy = await inAlpha(() =>
      legacyProjects.createProject(
        { businessId: alpha.businessId, actorUserId: alpha.ownerId },
        { name: "پروژهٔ قدیمی" },
      ),
    );
    // createProject (old path) does not write workspace_members, so the
    // workspace's own read must still admit the creator: `projectRoleFor`
    // falls back to the project's owner_user_id/created_by.
    const role = await inAlpha(() =>
      workspace.projectRoleFor(alpha.businessId, legacy.id, alpha.ownerId),
    );
    expect(role).not.toBeNull();
  });
});

/* ===========================================================================
 * Tenancy
 * ======================================================================== */

describe("tenant isolation", () => {
  it("never returns another business's project, contract or task", async () => {
    const project = await makeProject();
    await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان اسکلت",
        contractType: "contractor",
        projectId: project.id,
        status: "active",
        endDate: "2026-04-01",
      }),
    );

    const seen = await dbLib.withTenant(beta.businessId, () =>
      workspace.getWorkspaceProject(beta.businessId, project.id),
    );
    expect(seen).toBeNull();

    const contracts = await dbLib.withTenant(beta.businessId, () =>
      workspace.listContracts(beta.businessId, { status: "all" }),
    );
    expect(contracts).toHaveLength(0);

    const tasks = await dbLib.withTenant(beta.businessId, () =>
      workspace.listWorkspaceTasks(beta.businessId, { status: "all" }),
    );
    expect(tasks).toHaveLength(0);
  });

  it("refuses to attach another business's party to a project", async () => {
    const betaParty = await db.query<{ id: string }>(
      `INSERT INTO parties (business_id, name, role) VALUES ($1, 'کارفرمای بتا', 'customer') RETURNING id`,
      [beta.businessId],
    );
    await expect(
      inAlpha(() =>
        workspace.createWorkspaceProject(owner(), {
          name: "نشتِ مستأجر",
          partyId: betaParty.rows[0].id,
        }),
      ),
    ).rejects.toThrow();
  });
});

/* ===========================================================================
 * The second permission layer
 * ======================================================================== */

describe("project capabilities", () => {
  it("admits the creator as owner and refuses a non-member", async () => {
    const project = await makeProject();

    await expect(
      inAlpha(() => workspace.requireProjectCapability(owner(), project.id, "administer")),
    ).resolves.toBe("owner");

    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.outsiderId), project.id, "view"),
      ),
    ).rejects.toThrow();
  });

  it("gives a viewer read but not write, and an editor write", async () => {
    const project = await makeProject();
    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "viewer"));

    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.memberId), project.id, "view"),
      ),
    ).resolves.toBe("viewer");
    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.memberId), project.id, "edit"),
      ),
    ).rejects.toThrow();

    await inAlpha(() => workspace.setMember(owner(), project.id, alpha.memberId, "editor"));
    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.memberId), project.id, "edit"),
      ),
    ).resolves.toBe("editor");
  });

  it("lets a business-wide manager in without a member row (privileged)", async () => {
    const project = await makeProject();
    // `privileged` is what the API passes for a `workspace.manage` holder: a
    // manager must not be locked out of a project nobody added them to.
    await expect(
      inAlpha(() =>
        workspace.requireProjectCapability(owner(alpha.outsiderId), project.id, "manage", true),
      ),
    ).resolves.toBeTruthy();
  });

  it("refuses to remove the last owner", async () => {
    const project = await makeProject();
    await expect(
      inAlpha(() => workspace.removeMember(owner(), project.id, alpha.ownerId)),
    ).rejects.toThrow(/last_owner/);
  });
});

/* ===========================================================================
 * Templates and phases
 * ======================================================================== */

describe("templates", () => {
  it("seeds phases from a built-in template on create", async () => {
    const project = await makeProject({ templateKey: "construction" });
    const phases = await inAlpha(() => workspace.listPhases(project.id));
    expect(phases.length).toBeGreaterThan(2);
    expect(phases[0].displayOrder).toBeLessThan(phases[1].displayOrder);
  });

  it("lets a business override a built-in by key and archive its own", async () => {
    const saved = await inAlpha(() =>
      workspace.saveTemplate(owner(), {
        key: "construction",
        name: "ساخت‌وساز (نسخهٔ ما)",
        phases: [{ name: "پیش‌طراحی" }, { name: "اجرا" }],
        defaultTasks: ["اخذ پروانه"],
      }),
    );
    const construction = saved.filter((t) => t.key === "construction");
    expect(construction).toHaveLength(1);
    expect(construction[0].name).toBe("ساخت‌وساز (نسخهٔ ما)");

    const after = await inAlpha(() => workspace.archiveTemplate(alpha.businessId, "construction"));
    // Archiving the business row brings the built-in back rather than leaving
    // a hole — a built-in is code, shared by every tenant.
    expect(after.find((t) => t.key === "construction")?.name).not.toBe("ساخت‌وساز (نسخهٔ ما)");
  });
});

/* ===========================================================================
 * Tasks
 * ======================================================================== */

describe("tasks", () => {
  it("serves List, Kanban and Calendar from one query", async () => {
    const project = await makeProject();
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "سفارش میلگرد",
        assigneeUserId: alpha.memberId,
        dueDate: "2026-02-10",
        priority: "urgent",
      }),
    );
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "بازرسی جوش",
        status: "done",
      }),
    );

    const open = await inAlpha(() =>
      workspace.listWorkspaceTasks(alpha.businessId, { status: "open_only" }),
    );
    expect(open.map((t) => t.title)).toEqual(["سفارش میلگرد"]);

    const all = await inAlpha(() =>
      workspace.listWorkspaceTasks(alpha.businessId, { status: "all" }),
    );
    expect(all).toHaveLength(2);

    const mine = await inAlpha(() =>
      workspace.listWorkspaceTasks(alpha.businessId, {
        assigneeUserId: alpha.memberId,
        status: "all",
      }),
    );
    expect(mine.map((t) => t.title)).toEqual(["سفارش میلگرد"]);
    expect(mine[0].projectName).toBe("برج شمال");
  });

  it("carries a checklist and rolls it up onto the task", async () => {
    const project = await makeProject();
    const task = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "تحویل موقت" }),
    );
    const items = await inAlpha(() => workspace.addChecklistItem(task.id, "تست عایق"));
    await inAlpha(() => workspace.addChecklistItem(task.id, "تست برق"));
    await inAlpha(() => workspace.setChecklistItem(task.id, items[0].id, true));

    const read = await inAlpha(() => workspace.getWorkspaceTask(alpha.businessId, task.id));
    expect(read!.checklistTotal).toBe(2);
    expect(read!.checklistDone).toBe(1);
  });

  it("refuses a dependency that would close a cycle", async () => {
    const project = await makeProject();
    const a = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "الف" }),
    );
    const b = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, { title: "ب" }),
    );
    await inAlpha(() => workspace.addDependency(alpha.businessId, b.id, a.id));
    await expect(
      inAlpha(() => workspace.addDependency(alpha.businessId, a.id, b.id)),
    ).rejects.toThrow();
  });
});

/* ===========================================================================
 * Contracts, documents and the approval gate
 * ======================================================================== */

describe("the approval gate", () => {
  it("moves a contract draft → pending → active as it is decided", async () => {
    const project = await makeProject();
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان نما",
        contractType: "subcontractor",
        projectId: project.id,
        partyId: alpha.partyId,
        valueRial: 900_000_000,
        startDate: "2026-02-01",
        endDate: "2026-08-01",
      }),
    );
    expect(contract.status).toBe("draft");

    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        projectId: project.id,
        title: "تأیید پیمان نما",
        approverUserId: alpha.ownerId,
        dueDate: "2026-01-25",
      }),
    );
    expect(approval.status).toBe("pending");
    // Requesting propagates: the contract list must not still say «پیش‌نویس».
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!.status).toBe(
      "pending_approval",
    );

    const decided = await inAlpha(() =>
      workspace.decideApproval(owner(), approval.id, "approved", "تأیید شد"),
    );
    expect(decided!.status).toBe("approved");
    expect((await inAlpha(() => workspace.getContract(alpha.businessId, contract.id)))!.status).toBe(
      "active",
    );

    // A decided approval cannot be decided twice.
    const again = await inAlpha(() =>
      workspace.decideApproval(owner(), approval.id, "rejected"),
    );
    expect(again).toBeNull();
  });

  it("resolves the subject's own title rather than storing a copy", async () => {
    const project = await makeProject();
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), { title: "نام اول", contractType: "vendor" }),
    );
    await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        projectId: project.id,
        title: "تأیید",
      }),
    );
    await inAlpha(() => workspace.updateContract(owner(), contract.id, { title: "نام دوم" }));

    const [approval] = await inAlpha(() =>
      workspace.listApprovals(alpha.businessId, { status: "all" }),
    );
    expect(approval.subjectTitle).toBe("نام دوم");
  });
});

describe("documents", () => {
  it("chains versions and hides superseded ones from the default list", async () => {
    const project = await makeProject();
    const v1 = await inAlpha(() =>
      workspace.createDocument(owner(), {
        title: "نقشهٔ سازه",
        projectId: project.id,
        tags: ["نقشه"],
      }),
    );
    expect(v1.version).toBe(1);

    const v2 = await inAlpha(() =>
      workspace.createDocument(owner(), {
        title: "نقشهٔ سازه",
        projectId: project.id,
        supersedesId: v1.id,
      }),
    );
    expect(v2.version).toBe(2);

    const current = await inAlpha(() =>
      workspace.listDocuments(alpha.businessId, { projectId: project.id, currentOnly: true }),
    );
    expect(current.map((d) => d.id)).toEqual([v2.id]);

    // Newest revision first — a version history reads from the top. And the
    // chain is the same set whichever end you ask from.
    const chain = await inAlpha(() => workspace.listDocumentVersions(alpha.businessId, v2.id));
    expect(chain.map((d) => d.version)).toEqual([2, 1]);
    const fromRoot = await inAlpha(() => workspace.listDocumentVersions(alpha.businessId, v1.id));
    expect(fromRoot.map((d) => d.version)).toEqual([2, 1]);
  });
});

/* ===========================================================================
 * Calendar, dashboard and the accounting integration
 * ======================================================================== */

describe("dates crossing the driver boundary", () => {
  it("serves every date as YYYY-MM-DD, not as a stringified JS Date", async () => {
    // The bug this pins: node-postgres returns a `date` column as a JS Date,
    // and `String(d).slice(0, 10)` yields "Sun Mar 01" — ten characters of
    // `toString()`. It type-checks (it is a string), it survives every unit
    // test that does not look at the value, and it reaches the UI as a date no
    // picker can parse and no Jalali converter can read. Asserting the SHAPE
    // is the only thing that catches it.
    const iso = /^\d{4}-\d{2}-\d{2}$/;

    const project = await makeProject({ startDate: "2026-03-01", endDate: "2026-07-30" });
    expect(project.startDate).toMatch(iso);
    expect(project.endDate).toMatch(iso);
    expect(project.startDate).toBe("2026-03-01");
    expect(project.endDate).toBe("2026-07-30");

    // …and again on the read path, which is a different mapper.
    const fetched = await inAlpha(() =>
      workspace.getWorkspaceProject(alpha.businessId, project.id),
    );
    expect(fetched?.startDate).toBe("2026-03-01");
    const listed = await inAlpha(() => workspace.listWorkspaceProjects(alpha.businessId, {}));
    expect(listed.find((p) => p.id === project.id)?.endDate).toBe("2026-07-30");

    const task = await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "تاریخ‌دار",
        dueDate: "2026-04-05",
      }),
    );
    expect(task.dueDate).toBe("2026-04-05");
    const tasks = await inAlpha(() =>
      workspace.listWorkspaceTasks(alpha.businessId, { projectId: project.id }),
    );
    expect(tasks.find((t) => t.id === task.id)?.dueDate).toBe("2026-04-05");

    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان تاریخ‌دار",
        contractType: "vendor",
        projectId: project.id,
        startDate: "2026-03-05",
        endDate: "2026-10-15",
      }),
    );
    expect(contract.startDate).toBe("2026-03-05");
    expect(contract.endDate).toBe("2026-10-15");

    const approval = await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        projectId: project.id,
        title: "تأیید",
        dueDate: "2026-03-25",
      }),
    );
    expect(approval.dueDate).toBe("2026-03-25");

    // The calendar is the one place dates are compared as strings, so a
    // non-ISO value there silently breaks ordering and range filtering.
    const entries = await inAlpha(() =>
      workspace.listCalendar(alpha.businessId, { from: "2026-01-01", to: "2026-12-31" }),
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.date).toMatch(iso);
    // Sorted, which only holds if the strings really are ISO.
    const dates = entries.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("the unified calendar", () => {
  it("unions events with the four derived date sources", async () => {
    const project = await makeProject({ endDate: "2026-03-20" });
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "تحویل نقشه",
        dueDate: "2026-03-10",
      }),
    );
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), {
        title: "پیمان تأسیسات",
        contractType: "supplier",
        projectId: project.id,
        status: "active",
        endDate: "2026-03-15",
      }),
    );
    await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        projectId: project.id,
        title: "تأیید تأسیسات",
        dueDate: "2026-03-05",
      }),
    );
    await inAlpha(() =>
      workspace.createEvent(owner(), {
        title: "جلسهٔ کارگاهی",
        kind: "meeting",
        eventDate: "2026-03-12",
        projectId: project.id,
      }),
    );

    const entries = await inAlpha(() =>
      workspace.listCalendar(alpha.businessId, { from: "2026-03-01", to: "2026-03-31" }),
    );
    const sources = new Set(entries.map((e) => e.source));
    expect(sources).toContain("event");
    expect(sources).toContain("project_deadline");
    expect(sources).toContain("task_due");
    expect(sources).toContain("contract_expiry");
    expect(sources).toContain("approval_due");

    // A date outside the window is not in the answer.
    const narrow = await inAlpha(() =>
      workspace.listCalendar(alpha.businessId, { from: "2026-03-11", to: "2026-03-13" }),
    );
    expect(narrow.every((e) => e.date >= "2026-03-11" && e.date <= "2026-03-13")).toBe(true);
  });
});

describe("the dashboard and the report", () => {
  it("counts the four headline figures from the rows that own them", async () => {
    const project = await makeProject();
    await inAlpha(() =>
      workspace.createWorkspaceTask(owner(), project.id, {
        title: "کار من",
        assigneeUserId: alpha.ownerId,
        dueDate: new Date().toISOString().slice(0, 10),
      }),
    );
    const contract = await inAlpha(() =>
      workspace.createContract(owner(), { title: "پیمان", contractType: "consultant" }),
    );
    await inAlpha(() =>
      workspace.requestApproval(owner(), {
        subjectType: "contract",
        subjectId: contract.id,
        projectId: project.id,
        title: "تأیید",
      }),
    );

    const dash = await inAlpha(() =>
      workspace.getWorkspaceDashboard(alpha.businessId, alpha.ownerId),
    );
    expect(dash.activeProjects).toBe(1);
    expect(dash.tasksToday).toBeGreaterThanOrEqual(1);
    expect(dash.pendingApprovals).toBe(1);
    expect(dash.myTasks.length).toBeGreaterThanOrEqual(1);
    expect(dash.activity.length).toBeGreaterThan(0);
  });

  it("reads project spend from the ledger, not from a workspace counter", async () => {
    const project = await makeProject({ budgetRial: 1_000_000 });

    // A posted expense against this project, written the way Accounting does:
    // an entry carrying `project_id` and a debit line.
    const account = await db.query<{ id: string }>(
      `INSERT INTO accounts (business_id, code, name, type)
       VALUES ($1, '6001', 'هزینهٔ پروژه', 'expense') RETURNING id`,
      [alpha.businessId],
    );
    const entry = await db.query<{ id: string }>(
      `INSERT INTO journal_entries (business_id, entry_date, memo, project_id, created_by)
       VALUES ($1, CURRENT_DATE, 'خرید مصالح', $2, $3) RETURNING id`,
      [alpha.businessId, project.id, alpha.ownerId],
    );
    await db.query(
      `INSERT INTO journal_lines (entry_id, account_id, debit, credit)
       VALUES ($1, $2, 250000, 0)`,
      [entry.rows[0].id, account.rows[0].id],
    );

    const [row] = await inAlpha(() => workspace.projectReport(alpha.businessId));
    expect(row.projectId).toBe(project.id);
    expect(row.spentRial).toBe(250_000);
    expect(row.budgetRial).toBe(1_000_000);
  });
});
