import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import {
  KNOWLEDGE_SECTIONS,
  isKnownKnowledgeSection,
  parseKnowledgeUrl,
} from "@/lib/knowledge-base";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  withPlatformScope,
  platformAudit,
} from "@/lib/platform-auth";

/**
 * The platform side of the knowledge base (migration 0117). The super-admin
 * attaches one learning-page URL per dashboard section; every important page
 * in the user section offers that URL to its members through the «آموزش»
 * modal. A platform catalogue like `feature_flags`/`plans` — written here
 * only, read by tenant routes through GET /api/knowledge.
 */

type EntryRow = {
  section: string;
  url: string;
  is_active: boolean;
  notes: string;
  created_at: string;
  updated_at: string;
};

/**
 * Lists every catalogue section with the entry attached to it, if any. Any
 * active admin may read it (the list is just labels and public URLs); only
 * engineer/owner may write it, on PUT/DELETE.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const { rows } = await query<EntryRow>(
    "SELECT section, url, is_active, notes, created_at, updated_at FROM knowledge_base_entries",
  );
  const bySection = new Map(rows.map((r) => [r.section, r]));

  return NextResponse.json({
    sections: KNOWLEDGE_SECTIONS.map((s) => {
      const entry = bySection.get(s.key);
      return {
        section: s.key,
        label: s.label,
        route: s.route,
        url: entry?.url ?? null,
        is_active: entry?.is_active ?? false,
        notes: entry?.notes ?? "",
        updated_at: entry?.updated_at ?? null,
      };
    }),
  });
});

/** Creates or updates one section's learning page (upsert on `section`). */
export const PUT = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;

  let body: { section?: unknown; url?: unknown; is_active?: unknown; notes?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const section = typeof body.section === "string" ? body.section.trim() : "";
  if (!isKnownKnowledgeSection(section)) {
    return NextResponse.json({ error: "unknown_section" }, { status: 400 });
  }

  const parsed = parseKnowledgeUrl(body.url);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const isActive = body.is_active !== false;
  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 2000) : "";

  try {
    await query(
      `INSERT INTO knowledge_base_entries (section, url, is_active, notes, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (section)
       DO UPDATE SET url = EXCLUDED.url,
                    is_active = EXCLUDED.is_active,
                    notes = EXCLUDED.notes,
                    updated_at = now()`,
      [section, parsed.url, isActive, notes, session.padmin],
    );
  } catch (err) {
    console.error("knowledge base upsert failed", err);
    return NextResponse.json({ error: "upsert_failed" }, { status: 500 });
  }

  await platformAudit({
    adminId: session.padmin,
    action: "knowledge_base.save",
    entity: "knowledge_base_entries",
    entityId: section,
    payload: { section, is_active: isActive },
  });

  return NextResponse.json({ ok: true, section, url: parsed.url, is_active: isActive });
});

/** Deactivates one section's learning page (soft delete, keeps the URL). */
export const DELETE = withPlatformScope(async (request: NextRequest) => {
  const { session, error } = await requirePlatformCapability("knowledge.manage");
  if (error) return error;

  const section = (request.nextUrl.searchParams.get("section") ?? "").trim();
  if (!isKnownKnowledgeSection(section)) {
    return NextResponse.json({ error: "unknown_section" }, { status: 400 });
  }

  const { rowCount } = await query(
    "UPDATE knowledge_base_entries SET is_active = false, updated_at = now() WHERE section = $1",
    [section],
  );
  if ((rowCount ?? 0) === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await platformAudit({
    adminId: session.padmin,
    action: "knowledge_base.deactivate",
    entity: "knowledge_base_entries",
    entityId: section,
    payload: { section },
  });

  return NextResponse.json({ ok: true, section });
});
